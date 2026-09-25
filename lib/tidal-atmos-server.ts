import axios from 'axios';
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
// MP4, byte-for-byte what TIDAL serves: nothing is re-encoded or remuxed, so
// the Atmos (JOC) signalling in the ec-3 stream and its dec3 box survives.
//
// Built files are cached on local disk for a few minutes, because the download
// pipeline HEADs a track (for its size) before it GETs it.
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

const inFlight = new Map<string, Promise<string>>();

const cacheDir = () => path.join(os.tmpdir(), 'tidal-atmos');
const cachePath = (trackId: string) => path.join(cacheDir(), `${trackId}.m4a`);

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

// --- Manifest -----------------------------------------------------------------

type AtmosManifest = { mpdUrl: string };

async function fetchAtmosManifest(trackId: string): Promise<AtmosManifest> {
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
    return { mpdUrl: attributes.uri };
}

// --- MPD parsing ----------------------------------------------------------------
// TIDAL manifests are small and regular (one audio Representation with a
// SegmentTemplate + SegmentTimeline), so attribute regexes are enough here.

const decodeXML = (value: string) =>
    value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

const attr = (tag: string, name: string) => {
    const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? decodeXML(match[1]) : undefined;
};

export function segmentURLsFromMPD(mpd: string, mpdUrl: string): string[] {
    const representation = mpd.match(/<Representation\b[^>]*>/)?.[0] || '';
    const codecs = attr(representation, 'codecs') || '';
    if (!/ec-3|eac3/i.test(codecs)) throw new Error(`Expected an E-AC-3 (Atmos) stream but TIDAL sent "${codecs || 'unknown'}".`);
    if (/<ContentProtection\b/.test(mpd)) throw new Error('TIDAL served this Atmos stream DRM-protected, so it cannot be downloaded.');

    const baseURL = mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];
    const base = baseURL ? new URL(decodeXML(baseURL), mpdUrl).toString() : mpdUrl;
    const template = mpd.match(/<SegmentTemplate\b[^>]*>/)?.[0];
    // No template: a single-file representation addressed by its BaseURL alone.
    if (!template) {
        if (!baseURL) throw new Error('Unsupported TIDAL Atmos manifest layout.');
        return [base];
    }

    const initialization = attr(template, 'initialization');
    const media = attr(template, 'media');
    if (!media) throw new Error('Unsupported TIDAL Atmos manifest layout.');
    const startNumber = Number(attr(template, 'startNumber') ?? 1);

    // Each <S d="..." r="n"/> stands for 1 + n consecutive segments.
    let count = 0;
    for (const s of mpd.match(/<S\b[^>]*\/?>/g) || []) count += 1 + Number(attr(s, 'r') ?? 0);
    if (count === 0 || count > MAX_SEGMENTS) throw new Error('Unsupported TIDAL Atmos manifest layout.');

    const resolve = (value: string) => new URL(value, base).toString();
    const urls = initialization ? [resolve(initialization)] : [];
    for (let i = 0; i < count; i++)
        urls.push(resolve(media.replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => String(startNumber + i).padStart(Number(pad) || 0, '0'))));
    return urls;
}

// --- Assembly -------------------------------------------------------------------

async function buildAtmosFile(trackId: string): Promise<string> {
    const { mpdUrl } = await fetchAtmosManifest(trackId);
    const agent = proxyAgent();
    const mpd = (await axios.get(mpdUrl, { responseType: 'text', httpAgent: agent, httpsAgent: agent })).data as string;
    const urls = segmentURLsFromMPD(mpd, mpdUrl);

    // Fetch with bounded concurrency, then write in order.
    const parts: Buffer[] = new Array(urls.length);
    let next = 0;
    const worker = async () => {
        while (next < urls.length) {
            const index = next++;
            const response = await axios.get(urls[index], { responseType: 'arraybuffer', httpAgent: agent, httpsAgent: agent });
            parts[index] = Buffer.from(response.data);
        }
    };
    await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, urls.length) }, worker));

    await fs.promises.mkdir(cacheDir(), { recursive: true });
    const file = cachePath(trackId);
    // Write to a temp name first so a half-written file is never served.
    const temp = `${file}.${process.pid}.${Date.now()}.part`;
    await fs.promises.writeFile(temp, Buffer.concat(parts));
    await fs.promises.rename(temp, file);
    return file;
}

// Returns the path of the assembled Atmos file, building it (once, even under
// concurrent HEAD/GET requests) when it isn't cached yet.
export async function getAtmosFile(trackId: string): Promise<string> {
    if (!TRACK_ID_RE.test(trackId)) throw new Error('ID must be numeric');
    void sweepExpired();
    const file = cachePath(trackId);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS) return file;

    let pending = inFlight.get(trackId);
    if (!pending) {
        pending = buildAtmosFile(trackId).finally(() => inFlight.delete(trackId));
        inFlight.set(trackId, pending);
    }
    return pending;
}

// Cheap pre-check for /api/tidal/download-music so a non-Atmos track fails fast
// with a clear message instead of when the browser fetches the file.
export async function assertAtmosAvailable(trackId: string): Promise<void> {
    const stat = await fs.promises.stat(cachePath(trackId)).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < CACHE_TTL_MS) return;
    await fetchAtmosManifest(trackId);
}
