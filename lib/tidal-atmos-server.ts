import axios from 'axios';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tidalRequest } from './tidal-server';

// ---------------------------------------------------------------------------
// Server-only TIDAL Dolby Atmos (E-AC-3 JOC) assembler. Do NOT import into the client.
//
// The HiFi API only hands out Atmos through /trackManifests/?formats=EAC3_JOC,
// which answers with a DASH manifest (an init segment + numbered media
// segments) rather than one file URL, so /api/file can't proxy it directly.
// This fetches every segment and concatenates them into a single fragmented
// MP4, byte-for-byte what TIDAL serves. Nothing is re-encoded, downmixed or
// remuxed: the full mix — the 5.1 bed plus every JOC object and its OAMD
// positional metadata — reaches the client intact, so a downstream renderer
// (an AVR, Tryptify's object renderer) can render it to any speaker layout.
//
// Two consumers, two access patterns:
//   - the web download pipeline HEADs a track (for its size) and then GETs it,
//     so finished files are cached on local disk for a few minutes;
//   - players (Tryptify) GET from byte 0 and must see audio quickly, so an
//     uncached GET streams each segment as soon as it (and every one before it)
//     has arrived, instead of waiting for the whole file.
// ---------------------------------------------------------------------------

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const TRACK_ID_RE = /^\d{1,20}$/;
const CACHE_TTL_MS = 10 * 60 * 1000;
const SEGMENT_CONCURRENCY = 4;
// Sanity cap: a 20-minute Atmos track is ~450 segments at TIDAL's ~4 s segment length.
const MAX_SEGMENTS = 2000;

const cacheDir = () => path.join(os.tmpdir(), 'tidal-atmos');
const cachePath = (trackId: string) => path.join(cacheDir(), `${trackId}.m4a`);
const infoPath = (trackId: string) => path.join(cacheDir(), `${trackId}.json`);

function proxyAgent() {
    if (process.env.SOCKS5_PROXY) return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    return undefined;
}

async function sweepExpired() {
    const entries = await fs.promises.readdir(cacheDir()).catch(() => [] as string[]);
    const cutoff = Date.now() - CACHE_TTL_MS;
    await Promise.all(
        entries.map(async (name) => {
            const file = path.join(cacheDir(), name);
            const stat = await fs.promises.stat(file).catch(() => null);
            if (stat && stat.mtimeMs < cutoff) await fs.promises.unlink(file).catch(() => {});
        })
    );
}

// --- Stream description --------------------------------------------------------

// What the client is getting, so a player can tell a full Atmos mix apart from a
// stereo fallback before it decodes anything.
export type AtmosStreamInfo = {
    codec: string; // e.g. "ec-3"
    bandwidth: number | null; // bits per second
    sampleRate: number | null;
    // Dolby channel configuration of the bed, e.g. "F801" = 5.1 (L R C LFE Ls Rs).
    channelConfiguration: string | null;
    bedChannels: number | null;
    // "JOC" when the stream carries Joint Object Coding (the Atmos objects).
    extensionType: string | null;
    // JOC complexity index = the maximum number of simultaneously coded objects.
    objectCount: number | null;
};

// Dolby's 16-bit channel-configuration mask (ETSI TS 102 366 Annex I / DASH-IF IOP):
// bits, MSB first: L, C, R, Ls, Rs, Lc/Rc pair, Lrs/Rrs pair, Cs, Ts, Lsd/Rsd pair,
// Lw/Rw pair, Vhl/Vhr pair, Vhc, Lts/Rts pair, LFE2, LFE.
const DOLBY_CHANNEL_BITS = [1, 1, 1, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1, 2, 1, 1];

export function bedChannelsFromDolbyConfig(value: string | null | undefined): number | null {
    if (!value || !/^[0-9a-f]{4}$/i.test(value)) return null;
    const mask = parseInt(value, 16);
    let channels = 0;
    for (let bit = 0; bit < 16; bit++) if (mask & (1 << (15 - bit))) channels += DOLBY_CHANNEL_BITS[bit];
    return channels;
}

// --- Manifest -----------------------------------------------------------------

async function fetchAtmosManifestURL(trackId: string): Promise<string> {
    const body = await tidalRequest('/trackManifests/', {
        id: trackId,
        formats: 'EAC3_JOC',
        adaptive: 'false',
        manifestType: 'MPEG_DASH',
        uriScheme: 'HTTPS',
        usage: 'PLAYBACK'
    });
    // { version, data: { data: { attributes } } } — the inner envelope is TIDAL's JSON:API.
    const attributes = body?.data?.data?.attributes ?? body?.data?.attributes;
    if (!attributes?.uri) throw new Error('TIDAL returned no manifest for this track.');
    const formats: string[] = attributes.formats || [];
    // Asking only for EAC3_JOC still yields a stereo manifest when the track has no Atmos mix.
    if (!formats.includes('EAC3_JOC')) throw new Error('This track has no Dolby Atmos version on TIDAL.');
    if (attributes.drmData) throw new Error('TIDAL served this Atmos stream DRM-protected, so it cannot be downloaded.');
    return attributes.uri;
}

// --- MPD parsing ----------------------------------------------------------------
// TIDAL manifests are small and regular, so tag/attribute regexes are enough.
// A SegmentTemplate or AudioChannelConfiguration may sit on the Representation
// or be inherited from its AdaptationSet, and a manifest may offer several
// E-AC-3 representations: the one with the most bandwidth (the full mix) wins.

const decodeXML = (value: string) =>
    value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

const attr = (tag: string | undefined, name: string) => {
    const match = tag?.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? decodeXML(match[1]) : undefined;
};

const numberAttr = (tag: string | undefined, name: string) => {
    const value = Number(attr(tag, name));
    return Number.isFinite(value) && value > 0 ? value : null;
};

// Content of a <Tag ...>...</Tag> element or '' for a self-closing one.
// `[^>]` keeps the self-closing test on the open tag itself, so a child's "/>"
// (e.g. <S .../> inside a SegmentTimeline) can't end the element early.
const elementPattern = (tag: string, flags = 'g') => new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, flags);
const elements = (xml: string, tag: string) => xml.match(elementPattern(tag)) || [];
const firstElement = (xml: string, tag: string) => xml.match(elementPattern(tag, ''))?.[0];
const openTag = (element: string) => element.match(/^<[^>]*>/)?.[0] || '';

// Dolby DASH descriptors, from either the Representation or its AdaptationSet.
function dolbyProperty(scopes: string[], scheme: RegExp): string | null {
    for (const scope of scopes) {
        for (const tag of scope.match(/<(?:SupplementalProperty|EssentialProperty|AudioChannelConfiguration)\b[^>]*>/g) || []) {
            if (scheme.test(attr(tag, 'schemeIdUri') || '')) return attr(tag, 'value') ?? null;
        }
    }
    return null;
}

export type AtmosPlan = { urls: string[]; info: AtmosStreamInfo };

export function planFromMPD(mpd: string, mpdUrl: string): AtmosPlan {
    if (/<ContentProtection\b/.test(mpd)) throw new Error('TIDAL served this Atmos stream DRM-protected, so it cannot be downloaded.');
    const mpdBase = mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];

    type Candidate = { rep: string; set: string; setOwn: string; codecs: string; bandwidth: number };
    const candidates: Candidate[] = [];
    for (const set of elements(mpd, 'AdaptationSet')) {
        // The set's own children, i.e. without its representations, for inherited templates/descriptors.
        const setOwn = set.replace(elementPattern('Representation'), '');
        for (const rep of elements(set, 'Representation')) {
            const codecs = attr(openTag(rep), 'codecs') || attr(openTag(set), 'codecs') || '';
            candidates.push({ rep, set, setOwn, codecs, bandwidth: numberAttr(openTag(rep), 'bandwidth') ?? 0 });
        }
    }
    const atmos = candidates.filter((c) => /ec-3|eac3/i.test(c.codecs)).sort((a, b) => b.bandwidth - a.bandwidth);
    if (atmos.length === 0) {
        const sent =
            candidates
                .map((c) => c.codecs)
                .filter(Boolean)
                .join(', ') || 'unknown';
        throw new Error(`Expected an E-AC-3 (Atmos) stream but TIDAL sent "${sent}".`);
    }
    const { rep, set, setOwn, codecs, bandwidth } = atmos[0];
    const scopes = [rep, setOwn];

    const channelConfiguration = dolbyProperty(scopes, /audio_channel_configuration/i);
    const complexity = Number(dolbyProperty(scopes, /EC3_ExtensionComplexityIndex/i));
    const info: AtmosStreamInfo = {
        codec: codecs,
        bandwidth: bandwidth || null,
        sampleRate: numberAttr(openTag(rep), 'audioSamplingRate') ?? numberAttr(openTag(set), 'audioSamplingRate'),
        channelConfiguration,
        bedChannels: bedChannelsFromDolbyConfig(channelConfiguration),
        extensionType: dolbyProperty(scopes, /EC3_ExtensionType/i),
        objectCount: Number.isFinite(complexity) && complexity > 0 ? complexity : null
    };

    const repBase = rep.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];
    const base = [mpdBase, repBase].reduce<string>((url, next) => (next ? new URL(decodeXML(next), url).toString() : url), mpdUrl);
    const template = firstElement(rep, 'SegmentTemplate') || firstElement(setOwn, 'SegmentTemplate');
    // No template: a single-file representation addressed by its BaseURL alone.
    if (!template) {
        if (!repBase && !mpdBase) throw new Error('Unsupported TIDAL Atmos manifest layout.');
        return { urls: [base], info };
    }

    const templateTag = openTag(template);
    const initialization = attr(templateTag, 'initialization');
    const media = attr(templateTag, 'media');
    if (!media) throw new Error('Unsupported TIDAL Atmos manifest layout.');
    const startNumber = Number(attr(templateTag, 'startNumber') ?? 1);

    // Each <S d="..." r="n"/> stands for 1 + n consecutive segments.
    let count = 0;
    for (const s of template.match(/<S\b[^>]*\/?>/g) || []) count += 1 + Number(attr(s, 'r') ?? 0);
    if (count === 0 || count > MAX_SEGMENTS) throw new Error('Unsupported TIDAL Atmos manifest layout.');

    const representationId = attr(openTag(rep), 'id') || '';
    const fill = (value: string, number?: number) =>
        new URL(
            value
                .replace(/\$RepresentationID\$/g, representationId)
                .replace(/\$Bandwidth\$/g, String(bandwidth))
                .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => String(number ?? startNumber).padStart(Number(pad) || 0, '0')),
            base
        ).toString();
    const urls = initialization ? [fill(initialization)] : [];
    for (let i = 0; i < count; i++) urls.push(fill(media, startNumber + i));
    return { urls, info };
}

// Kept for the original single-representation callers/tests.
export const segmentURLsFromMPD = (mpd: string, mpdUrl: string) => planFromMPD(mpd, mpdUrl).urls;

async function fetchPlan(trackId: string): Promise<AtmosPlan> {
    const mpdUrl = await fetchAtmosManifestURL(trackId);
    const agent = proxyAgent();
    const mpd = (await axios.get(mpdUrl, { responseType: 'text', httpAgent: agent, httpsAgent: agent })).data as string;
    return planFromMPD(mpd, mpdUrl);
}

// --- Assembly -------------------------------------------------------------------

// One in-flight build per track. Segments are fetched with bounded concurrency
// into `parts`; `ready` counts the contiguous prefix that has arrived, which is
// what progressive readers may send. `done` resolves with the cached file path.
class AtmosBuild extends EventEmitter {
    parts: Buffer[] = [];
    ready = 0;
    total = 0;
    failed: Error | null = null;
    info: AtmosStreamInfo | null = null;
    done: Promise<string>;

    constructor(readonly trackId: string) {
        super();
        this.setMaxListeners(0);
        this.done = this.run();
        // Progressive readers observe failures through 'progress'; don't leak an unhandled rejection.
        this.done.catch(() => {});
    }

    private async run(): Promise<string> {
        try {
            const { urls, info } = await fetchPlan(this.trackId);
            this.info = info;
            this.total = urls.length;
            this.emit('progress');
            const agent = proxyAgent();
            let next = 0;
            const worker = async () => {
                while (next < urls.length && !this.failed) {
                    const index = next++;
                    const response = await axios.get(urls[index], { responseType: 'arraybuffer', httpAgent: agent, httpsAgent: agent });
                    this.parts[index] = Buffer.from(response.data);
                    while (this.ready < this.total && this.parts[this.ready]) this.ready++;
                    this.emit('progress');
                }
            };
            await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, urls.length) }, worker));

            await fs.promises.mkdir(cacheDir(), { recursive: true });
            const file = cachePath(this.trackId);
            // Write to a temp name first so a half-written file is never served.
            const temp = `${file}.${process.pid}.${Date.now()}.part`;
            await fs.promises.writeFile(temp, Buffer.concat(this.parts));
            await fs.promises.rename(temp, file);
            await fs.promises.writeFile(infoPath(this.trackId), JSON.stringify(info));
            return file;
        } catch (error) {
            this.failed = error instanceof Error ? error : new Error(String(error));
            this.emit('progress');
            throw this.failed;
        } finally {
            inFlight.delete(this.trackId);
        }
    }

    // Yields segments in order as they become available.
    async *stream(): AsyncGenerator<Buffer> {
        let sent = 0;
        while (true) {
            if (this.failed) throw this.failed;
            if (this.total > 0 && sent >= this.total) return;
            if (sent < this.ready) {
                yield this.parts[sent++];
                continue;
            }
            await new Promise<void>((resolve) => this.once('progress', () => resolve()));
        }
    }
}

// Next.js bundles each route separately, so module state isn't shared between
// /download-music (which starts a build) and /atmos-file (which streams it).
// globalThis is, so in-flight builds live there.
const globalBuilds = globalThis as typeof globalThis & { __tidalAtmosBuilds?: Map<string, AtmosBuild> };
const inFlight = (globalBuilds.__tidalAtmosBuilds ??= new Map<string, AtmosBuild>());

function buildFor(trackId: string): AtmosBuild {
    let build = inFlight.get(trackId);
    if (!build) {
        build = new AtmosBuild(trackId);
        inFlight.set(trackId, build);
    }
    return build;
}

async function cachedFile(trackId: string): Promise<string | null> {
    const stat = await fs.promises.stat(cachePath(trackId)).catch(() => null);
    return stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS ? cachePath(trackId) : null;
}

const validate = (trackId: string) => {
    if (!TRACK_ID_RE.test(trackId)) throw new Error('ID must be numeric');
    void sweepExpired();
};

// Path of the assembled Atmos file, building it (once, even under concurrent
// HEAD/GET requests) when it isn't cached yet.
export async function getAtmosFile(trackId: string): Promise<string> {
    validate(trackId);
    return (await cachedFile(trackId)) ?? buildFor(trackId).done;
}

// Either the cached file, or a live build a progressive reader can stream from.
export async function openAtmos(trackId: string): Promise<{ file: string } | { build: AtmosBuild }> {
    validate(trackId);
    const file = await cachedFile(trackId);
    return file ? { file } : { build: buildFor(trackId) };
}

// Checks the track has a downloadable Atmos mix and describes it, so
// /api/tidal/download-music fails fast with a clear message for a non-Atmos
// track and tells the client exactly what it is about to receive.
export async function describeAtmos(trackId: string): Promise<AtmosStreamInfo> {
    validate(trackId);
    if (await cachedFile(trackId)) {
        const info = await fs.promises.readFile(infoPath(trackId), 'utf8').catch(() => null);
        if (info) return JSON.parse(info) as AtmosStreamInfo;
    }
    // Starting the build here means the client's first GET usually finds segments waiting.
    const build = buildFor(trackId);
    if (!build.info && !build.failed) await new Promise<void>((resolve) => build.once('progress', () => resolve()));
    if (build.failed) throw build.failed;
    return build.info!;
}
