import axios, { AxiosRequestConfig } from 'axios';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import Blowfish from 'blowfish-node';

// ---------------------------------------------------------------------------
// Server-only Deezer full-track downloads. Do not import this into the client.
//
// Counterpart to getDownloadURL in lib/qobuz-dl-server.tsx, but Deezer needs
// three steps where Qobuz needs one, all authenticated by the DEEZER_ARL cookie:
//
//   1. deezer.getUserData (private gw-light API) -> api_token + license_token
//   2. song.getData                              -> the track's TRACK_TOKEN
//   3. media.deezer.com/v1/get_url               -> a CDN URL for the file
//
// The CDN file is "BF_CBC_STRIPE" encrypted: every third 2048-byte block is
// Blowfish-CBC encrypted with a per-track key, the rest is plain. So unlike
// Qobuz/TIDAL the CDN URL can't be handed to /api/file; /api/deezer/file streams
// it through decryptStripes() instead. Decryption keeps the file size and block
// offsets, so byte ranges map 1:1 onto the CDN file (players can seek).
//
// Blowfish comes from blowfish-node because OpenSSL 3 (Node 17+) only has it
// in the legacy provider, which node:crypto refuses by default.
// ---------------------------------------------------------------------------

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const GW_API = 'https://www.deezer.com/ajax/gw-light.php';
const MEDIA_API = 'https://media.deezer.com/v1/get_url';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Re-login after this long; Deezer's api_token/license_token outlive it comfortably.
const SESSION_TTL_MS = 60 * 60 * 1000;

export const BLOCK_SIZE = 2048;
const STRIPE_SECRET = 'g4el58wc0zvf9na1';
const STRIPE_IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);

// Deezer formats, best first, keyed by the Qobuz quality ids the routes accept.
// get_url returns the first format in the list the account and track allow.
export type DeezerFormat = 'FLAC' | 'MP3_320' | 'MP3_128';
const FORMAT_LADDER: Record<string, DeezerFormat[]> = {
    '27': ['FLAC', 'MP3_320', 'MP3_128'],
    '7': ['FLAC', 'MP3_320', 'MP3_128'],
    '6': ['FLAC', 'MP3_320', 'MP3_128'],
    '5': ['MP3_320', 'MP3_128']
};
export const DEEZER_FORMATS: DeezerFormat[] = ['FLAC', 'MP3_320', 'MP3_128'];
export const formatMime = (format: DeezerFormat) => (format === 'FLAC' ? 'audio/flac' : 'audio/mpeg');
export const formatExtension = (format: DeezerFormat) => (format === 'FLAC' ? 'flac' : 'mp3');

export function testForDeezerRequirements() {
    if (!process.env.DEEZER_ARL) {
        throw new Error('Deployment is missing DEEZER_ARL environment variable. Get it from your Deezer session cookies (arl cookie).');
    }
}

function proxyAgent() {
    if (process.env.SOCKS5_PROXY) return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    return undefined;
}

function requestConfig(cookie: string, options: AxiosRequestConfig = {}): AxiosRequestConfig {
    const agent = proxyAgent();
    return { httpAgent: agent, httpsAgent: agent, timeout: 15000, ...options, headers: { 'User-Agent': USER_AGENT, Cookie: cookie, ...options.headers } };
}

// --- Session ---------------------------------------------------------------

type Session = { apiToken: string; licenseToken: string; cookie: string; expires: number };
// On globalThis so every route bundle shares one login (see lib/deezer-server.tsx's pacer).
const sessionCache: { current?: Promise<Session> } = ((globalThis as any).__deezerSession ??= {});

async function login(): Promise<Session> {
    testForDeezerRequirements();
    const arlCookie = `arl=${process.env.DEEZER_ARL}`;
    const response = await axios.get(
        GW_API,
        requestConfig(arlCookie, { params: { method: 'deezer.getUserData', input: 3, api_version: '1.0', api_token: '' } })
    );
    const results = response.data?.results;
    if (!results?.USER?.USER_ID) throw new Error('Deezer rejected DEEZER_ARL (not logged in). The arl cookie has likely expired; copy a fresh one.');
    // The gateway also wants the sid session cookie it just set.
    const sid = (response.headers['set-cookie'] || []).map((c: string) => c.split(';')[0]).find((c: string) => c.startsWith('sid='));
    return {
        apiToken: results.checkForm,
        licenseToken: results.USER.OPTIONS?.license_token,
        cookie: sid ? `${arlCookie}; ${sid}` : arlCookie,
        expires: Date.now() + SESSION_TTL_MS
    };
}

async function getSession(fresh = false): Promise<Session> {
    const cached = sessionCache.current;
    if (!fresh && cached) {
        const session = await cached.catch(() => null);
        if (session && session.expires > Date.now()) return session;
    }
    const next = login();
    sessionCache.current = next;
    next.catch(() => {
        if (sessionCache.current === next) sessionCache.current = undefined;
    });
    return next;
}

async function gatewayCall(method: string, body: object, options: AxiosRequestConfig = {}): Promise<any> {
    for (const fresh of [false, true]) {
        const session = await getSession(fresh);
        const response = await axios.post(
            GW_API,
            body,
            requestConfig(session.cookie, { ...options, params: { method, input: 3, api_version: '1.0', api_token: session.apiToken } })
        );
        const error = response.data?.error;
        const hasError = error && (Array.isArray(error) ? error.length > 0 : Object.keys(error).length > 0);
        if (!hasError) return response.data.results;
        // An expired api_token: log in again once and retry.
        if (!fresh && (error.VALID_TOKEN_REQUIRED || error.GATEWAY_ERROR)) continue;
        throw new Error(`Deezer: ${JSON.stringify(error)}`);
    }
}

// --- Resolving a track to its encrypted CDN file -------------------------------

export type DeezerTrackFile = {
    url: string;
    format: DeezerFormat;
    // The id the file is encrypted with. Deezer may substitute a fallback
    // version of the track, whose id differs from the one requested.
    songId: string;
};

export async function resolveTrackFile(trackId: string, formats: DeezerFormat[], options: AxiosRequestConfig = {}): Promise<DeezerTrackFile> {
    const song = await gatewayCall('song.getData', { sng_id: trackId }, options);
    if (!song?.TRACK_TOKEN) throw new Error('Deezer returned no track token for this track.');
    const { licenseToken } = await getSession();
    const agent = proxyAgent();
    const response = await axios.post(
        MEDIA_API,
        {
            license_token: licenseToken,
            media: [{ type: 'FULL', formats: formats.map((format) => ({ cipher: 'BF_CBC_STRIPE', format })) }],
            track_tokens: [song.TRACK_TOKEN]
        },
        { httpAgent: agent, httpsAgent: agent, timeout: 15000, ...options, headers: { 'User-Agent': USER_AGENT, ...options.headers } }
    );
    const entry = response.data?.data?.[0];
    const media = entry?.media?.[0];
    const url = media?.sources?.[0]?.url;
    if (!url) {
        const reason = entry?.errors?.[0]?.message || response.data?.errors?.[0]?.message;
        throw new Error(`Deezer won't serve this track in ${formats.join('/')}${reason ? `: ${reason}` : ''}. Check that the ARL's plan includes it.`);
    }
    return { url, format: media.format as DeezerFormat, songId: String(song.SNG_ID || trackId) };
}

// Picks the best format the account can get for a Qobuz quality id. Returns the
// format only: /api/deezer/file resolves a fresh CDN URL when it is requested,
// since CDN URLs are short-lived and the signed link may be used much later.
export async function getDownloadFormat(trackId: string, quality: string, options: AxiosRequestConfig = {}): Promise<DeezerFormat> {
    const ladder = FORMAT_LADDER[quality];
    if (!ladder) throw new Error(`Invalid quality: ${quality}. Valid: ${Object.keys(FORMAT_LADDER).join(', ')}`);
    return (await resolveTrackFile(trackId, ladder, options)).format;
}

// --- Decryption ------------------------------------------------------------

function trackKey(songId: string): Buffer {
    const md5 = crypto.createHash('md5').update(songId, 'ascii').digest('hex');
    const key = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) key[i] = md5.charCodeAt(i) ^ md5.charCodeAt(i + 16) ^ STRIPE_SECRET.charCodeAt(i);
    return key;
}

// Decrypts a CDN byte stream that starts at block `firstBlock` (its byte offset
// divided by BLOCK_SIZE, so the stream must start on a block boundary). Every
// full block whose index is a multiple of 3 is encrypted, each with a fresh IV;
// a short final block is always plain.
export async function* decryptStripes(source: Readable, songId: string, firstBlock: number): AsyncGenerator<Buffer> {
    const cipher = new Blowfish(trackKey(songId), Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
    let pending: Buffer = Buffer.alloc(0);
    let block = firstBlock;
    const decode = (chunk: Buffer) => {
        if (block++ % 3 !== 0) return chunk;
        cipher.setIv(STRIPE_IV);
        return Buffer.from(cipher.decode(chunk, Blowfish.TYPE.UINT8_ARRAY) as Uint8Array);
    };
    for await (const data of source) {
        pending = pending.length ? Buffer.concat([pending, data as Buffer]) : (data as Buffer);
        const whole = pending.length - (pending.length % BLOCK_SIZE);
        if (!whole) continue;
        const out: Buffer[] = [];
        for (let offset = 0; offset < whole; offset += BLOCK_SIZE) out.push(decode(pending.subarray(offset, offset + BLOCK_SIZE)));
        pending = pending.subarray(whole);
        yield Buffer.concat(out);
    }
    if (pending.length) yield pending;
}
