import axios from 'axios';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Server-only assembler for TIDAL's DASH streams. Do NOT import into the client.
//
// TIDAL serves Dolby Atmos, and on some accounts every quality, as a DASH
// manifest: an init segment + numbered media segments rather than one file,
// so /api/file can't proxy it directly. A DashBuild fetches one
// representation's segments and joins them into a single file, optionally
// transforming each segment on the way (lib/tidal-stream-server.ts turns
// FLAC-in-MP4 into a plain .flac; Atmos is passed through untouched).
//
// Two consumers, two access patterns:
//   - the web download pipeline HEADs a file (for its size) and then GETs it,
//     so finished files are cached on local disk for a few minutes;
//   - players GET from byte 0 and must hear audio quickly, so an uncached GET
//     streams each segment as soon as it (and every one before it) has arrived,
//     instead of waiting for the whole file.
// ---------------------------------------------------------------------------

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const SEGMENT_CONCURRENCY = 4;
// Sanity cap: a 20-minute track is ~300 segments at TIDAL's ~4 s segment length.
const MAX_SEGMENTS = 2000;

const cacheDir = () => path.join(os.tmpdir(), 'tidal-dash');
const cachePath = (key: string, ext: string) => path.join(cacheDir(), `${key}.${ext}`);
const infoPath = (key: string) => path.join(cacheDir(), `${key}.json`);

export function proxyAgent() {
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

// --- MPD parsing ----------------------------------------------------------------
// TIDAL manifests are small and regular, so tag/attribute regexes are enough.
// A SegmentTemplate or descriptor may sit on the Representation or be inherited
// from its AdaptationSet, and a manifest may offer several representations of a
// codec: the one with the most bandwidth wins.

const decodeXML = (value: string) =>
    value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

export const attr = (tag: string | undefined, name: string) => {
    const match = tag?.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? decodeXML(match[1]) : undefined;
};

export const numberAttr = (tag: string | undefined, name: string) => {
    const value = Number(attr(tag, name));
    return Number.isFinite(value) && value > 0 ? value : null;
};

// Content of a <Tag ...>...</Tag> element or '' for a self-closing one.
// `[^>]` keeps the self-closing test on the open tag itself, so a child's "/>"
// (e.g. <S .../> inside a SegmentTimeline) can't end the element early.
const elementPattern = (tag: string, flags = 'g') => new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, flags);
const elements = (xml: string, tag: string) => xml.match(elementPattern(tag)) || [];
const firstElement = (xml: string, tag: string) => xml.match(elementPattern(tag, ''))?.[0];
export const openTag = (element: string) => element.match(/^<[^>]*>/)?.[0] || '';

export type DashRepresentation = {
    rep: string; // the <Representation> element
    set: string; // its <AdaptationSet>
    setOwn: string; // the set's own children, without its representations (inherited templates/descriptors)
    codecs: string;
    bandwidth: number;
};

export type DashPlan = {
    urls: string[]; // init segment (when there is one) then every media segment, in order
    initialization: boolean; // whether urls[0] is an init segment
    representation: DashRepresentation;
    // Total length in timescale units, summed from the SegmentTimeline (null without one).
    duration: { ticks: number; timescale: number } | null;
};

// Picks the highest-bandwidth representation whose codecs match `accept.codecs`
// and lists its segment URLs. `accept.name` names the expected audio in errors.
export function planFromMPD(mpd: string, mpdUrl: string, accept: { codecs: RegExp; name: string }): DashPlan {
    if (/<ContentProtection\b/.test(mpd)) throw new Error(`TIDAL served this ${accept.name} stream DRM-protected, so it cannot be downloaded.`);
    const mpdBase = mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];

    const candidates: DashRepresentation[] = [];
    for (const set of elements(mpd, 'AdaptationSet')) {
        const setOwn = set.replace(elementPattern('Representation'), '');
        for (const rep of elements(set, 'Representation')) {
            const codecs = attr(openTag(rep), 'codecs') || attr(openTag(set), 'codecs') || '';
            candidates.push({ rep, set, setOwn, codecs, bandwidth: numberAttr(openTag(rep), 'bandwidth') ?? 0 });
        }
    }
    const matching = candidates.filter((c) => accept.codecs.test(c.codecs)).sort((a, b) => b.bandwidth - a.bandwidth);
    if (matching.length === 0) {
        const sent =
            candidates
                .map((c) => c.codecs)
                .filter(Boolean)
                .join(', ') || 'unknown';
        throw new Error(`Expected ${accept.name} audio but TIDAL sent "${sent}".`);
    }
    const representation = matching[0];
    const { rep, setOwn, bandwidth } = representation;

    const repBase = rep.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];
    const base = [mpdBase, repBase].reduce<string>((url, next) => (next ? new URL(decodeXML(next), url).toString() : url), mpdUrl);
    const template = firstElement(rep, 'SegmentTemplate') || firstElement(setOwn, 'SegmentTemplate');
    // No template: a single-file representation addressed by its BaseURL alone.
    if (!template) {
        if (!repBase && !mpdBase) throw new Error('Unsupported TIDAL DASH manifest layout.');
        return { urls: [base], initialization: false, representation, duration: null };
    }

    const templateTag = openTag(template);
    const initialization = attr(templateTag, 'initialization');
    const media = attr(templateTag, 'media');
    if (!media) throw new Error('Unsupported TIDAL DASH manifest layout.');
    const startNumber = Number(attr(templateTag, 'startNumber') ?? 1);
    const timescale = numberAttr(templateTag, 'timescale');

    // Each <S d="..." r="n"/> stands for 1 + n consecutive segments of d ticks.
    let count = 0;
    let ticks = 0;
    for (const s of template.match(/<S\b[^>]*\/?>/g) || []) {
        const repeat = 1 + Number(attr(s, 'r') ?? 0);
        count += repeat;
        ticks += repeat * Number(attr(s, 'd') ?? 0);
    }
    if (count === 0 || count > MAX_SEGMENTS) throw new Error('Unsupported TIDAL DASH manifest layout.');

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
    return {
        urls,
        initialization: Boolean(initialization),
        representation,
        duration: timescale && Number.isFinite(ticks) && ticks > 0 ? { ticks, timescale } : null
    };
}

// --- Assembly -------------------------------------------------------------------

// Rewrites segment `index` (0 = the init segment when the plan has one) on its way into the file.
export type SegmentTransform = (index: number, data: Buffer) => Buffer;

// What a build needs: the segment URLs, a description saved beside the file, and an optional transform.
export type BuildPlan<I> = { urls: string[]; info: I; transform?: SegmentTransform };

// One in-flight build per key. Segments are fetched with bounded concurrency
// into `parts`; `ready` counts the contiguous prefix that has arrived, which is
// what progressive readers may send. `done` resolves with the cached file path.
export class DashBuild<I = unknown> extends EventEmitter {
    parts: Buffer[] = [];
    ready = 0;
    total = 0;
    failed: Error | null = null;
    info: I | null = null;
    done: Promise<string>;

    constructor(
        readonly key: string,
        readonly ext: string,
        private readonly plan: () => Promise<BuildPlan<I>>
    ) {
        super();
        this.setMaxListeners(0);
        this.done = this.run();
        // Progressive readers observe failures through 'progress'; don't leak an unhandled rejection.
        this.done.catch(() => {});
    }

    private async run(): Promise<string> {
        try {
            const { urls, info, transform } = await this.plan();
            this.info = info;
            this.total = urls.length;
            this.emit('progress');
            const agent = proxyAgent();
            let next = 0;
            const worker = async () => {
                while (next < urls.length && !this.failed) {
                    const index = next++;
                    const response = await axios.get(urls[index], { responseType: 'arraybuffer', httpAgent: agent, httpsAgent: agent });
                    const data = Buffer.from(response.data);
                    this.parts[index] = transform ? transform(index, data) : data;
                    while (this.ready < this.total && this.parts[this.ready]) this.ready++;
                    this.emit('progress');
                }
            };
            await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, urls.length) }, worker));

            await fs.promises.mkdir(cacheDir(), { recursive: true });
            const file = cachePath(this.key, this.ext);
            // Write to a temp name first so a half-written file is never served.
            const temp = `${file}.${process.pid}.${Date.now()}.part`;
            await fs.promises.writeFile(temp, Buffer.concat(this.parts));
            await fs.promises.rename(temp, file);
            await fs.promises.writeFile(infoPath(this.key), JSON.stringify(info));
            return file;
        } catch (error) {
            this.failed = error instanceof Error ? error : new Error(String(error));
            this.emit('progress');
            throw this.failed;
        } finally {
            inFlight.delete(this.key);
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
// e.g. /download-music (which starts a build) and /atmos-file (which streams it).
// globalThis is, so in-flight builds live there.
const globalBuilds = globalThis as typeof globalThis & { __tidalDashBuilds?: Map<string, DashBuild<any>> };
const inFlight = (globalBuilds.__tidalDashBuilds ??= new Map<string, DashBuild<any>>());

function buildFor<I>(key: string, ext: string, plan: () => Promise<BuildPlan<I>>): DashBuild<I> {
    let build = inFlight.get(key) as DashBuild<I> | undefined;
    if (!build) {
        build = new DashBuild<I>(key, ext, plan);
        inFlight.set(key, build);
    }
    return build;
}

async function cachedFile(key: string, ext: string): Promise<string | null> {
    const stat = await fs.promises.stat(cachePath(key, ext)).catch(() => null);
    return stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS ? cachePath(key, ext) : null;
}

export type OpenedDash<I = unknown> = { file: string } | { build: DashBuild<I> };

// Either the cached file, or a live build (started now if none is running) a progressive reader can stream from.
export async function openDash<I>(key: string, ext: string, plan: () => Promise<BuildPlan<I>>): Promise<OpenedDash<I>> {
    void sweepExpired();
    const file = await cachedFile(key, ext);
    return file ? { file } : { build: buildFor(key, ext, plan) };
}

// Path of the assembled file, building it (once, even under concurrent requests) when it isn't cached yet.
export async function dashFile<I>(key: string, ext: string, plan: () => Promise<BuildPlan<I>>): Promise<string> {
    const opened = await openDash(key, ext, plan);
    return 'file' in opened ? opened.file : opened.build.done;
}

// The build's description, as soon as its plan is known: fails fast (e.g. no
// such stream) and starts the build, so the client's first GET usually finds
// segments waiting.
export async function describeDash<I>(key: string, ext: string, plan: () => Promise<BuildPlan<I>>): Promise<I> {
    const opened = await openDash(key, ext, plan);
    if ('file' in opened) {
        const info = await fs.promises.readFile(infoPath(key), 'utf8').catch(() => null);
        if (info) return JSON.parse(info) as I;
    }
    const build = 'build' in opened ? opened.build : buildFor(key, ext, plan);
    if (!build.info && !build.failed) await new Promise<void>((resolve) => build.once('progress', () => resolve()));
    if (build.failed) throw build.failed;
    return build.info!;
}
