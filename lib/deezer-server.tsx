import axios from 'axios';
import {
    DeezerAlbum,
    DeezerArtist,
    DeezerError,
    DeezerList,
    DeezerTrack,
    deezerReleaseBucket,
    matchDeezerUrl,
    normalizeDeezerAlbum,
    normalizeDeezerAlbumFull,
    normalizeDeezerSearch,
    parseDeezerArtistData
} from './deezer';
import { APIOptionProps, FetchedQobuzAlbum, QobuzArtistResults, QobuzSearchResults } from './qobuz-dl';

// ---------------------------------------------------------------------------
// Server-only Deezer public-API client.
//
// Counterpart to lib/apple-music-server.tsx. Do NOT import this into the client.
//
//   - Talks to api.deezer.com (no key needed) with the same CORS_PROXY /
//     SOCKS5_PROXY passthrough the Qobuz and Apple clients use.
//   - Turns Deezer's "HTTP 200 + { error }" failures into thrown errors and
//     backs off on its rate limit (50 requests / 5 s per IP).
//   - Normalizes responses into the shared Qobuz* shapes.
// ---------------------------------------------------------------------------

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const DEEZER_API_BASE = () => process.env.DEEZER_API_BASE || 'https://api.deezer.com';
const QUOTA_EXCEEDED = 4;
// Upper bound on how much of an artist's discography we pull (Deezer pages at 100).
const MAX_DISCOGRAPHY = 500;

function proxyAgent() {
    if (process.env.SOCKS5_PROXY) return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    return undefined;
}

// --- Pacing and retries ----------------------------------------------------
//
// Deezer's API sits behind a CDN that answers a burst of parallel requests from
// one IP with an HTML "Access Denied" page (HTTP 403) — well before the
// documented 50 requests / 5 s, and most readily for datacenter IPs. A search
// fans out three requests at once and an artist page three more plus its
// discography pages, so a couple of people browsing tripped it, and one refused
// request failed the whole page. So every request goes through one shared
// queue: at most MAX_IN_FLIGHT at a time, starts spaced MIN_SPACING_MS apart,
// and the transient failures (CDN refusal, 429, 5xx, a dropped connection,
// Deezer's own quota error) are retried with a growing, jittered wait.

const MAX_IN_FLIGHT = 2;
const MIN_SPACING_MS = 120;
const MAX_ATTEMPTS = 5;

type Pacer = { inFlight: number; lastStart: number; waiting: (() => void)[] };
// On globalThis: each route bundle gets its own copy of this module, and they
// must share one queue — the CDN counts the server's IP, not the route.
const pacer: Pacer = ((globalThis as any).__deezerPacer ??= { inFlight: 0, lastStart: 0, waiting: [] });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquire() {
    while (pacer.inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => pacer.waiting.push(resolve));
    pacer.inFlight++;
    const wait = pacer.lastStart + MIN_SPACING_MS - Date.now();
    pacer.lastStart = Math.max(Date.now(), pacer.lastStart + MIN_SPACING_MS);
    if (wait > 0) await sleep(wait);
}

function release() {
    pacer.inFlight--;
    pacer.waiting.shift()?.();
}

function isTransient(error: any): boolean {
    const status = error?.response?.status;
    if (status === 403 || status === 429 || (status >= 500 && status < 600)) return true;
    // No response at all: reset, timeout, refused.
    return !error?.response && ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'].includes(error?.code);
}

// 0.5 s, 1 s, 2 s, 4 s, each ±25 %, so parallel retries don't land together again.
const backoff = (attempt: number) => 500 * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5);

export async function deezerRequest<T = any>(path: string, params: Record<string, string | number | undefined> = {}, options: APIOptionProps = {}): Promise<T> {
    const { country, ...requestOptions } = options;
    void country; // the public API picks the region from the caller's IP
    const url = new URL(DEEZER_API_BASE().replace(/\/$/, '') + path);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
    }
    const agent = proxyAgent();
    const target = process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString();

    for (let attempt = 0; ; attempt++) {
        const last = attempt >= MAX_ATTEMPTS - 1;
        let data: any;
        let failure: any = null;
        // The slot is held for the request only — never across a backoff wait,
        // or one retrying request would stall everyone else.
        await acquire();
        try {
            data = (await axios.get(target, { httpAgent: agent, httpsAgent: agent, timeout: 15000, ...requestOptions })).data;
        } catch (error: any) {
            failure = error;
        } finally {
            release();
        }
        if (failure) {
            if (!last && isTransient(failure)) {
                await sleep(backoff(attempt));
                continue;
            }
            const status = failure?.response?.status;
            throw new Error(status === 403
                ? `Deezer refused the request (HTTP 403 from its CDN) ${attempt + 1} times; try again in a moment.`
                : `Deezer: ${failure?.message || 'request failed'}`);
        }
        const deezerError = (data as DeezerError)?.error;
        if (!deezerError) return data as T;
        if (deezerError.code === QUOTA_EXCEEDED && !last) {
            await sleep(backoff(attempt));
            continue;
        }
        throw new Error(`Deezer: ${deezerError.message || deezerError.type} (code ${deezerError.code})`);
    }
}

// --- Low-level fetches -----------------------------------------------------

const fetchTrack = (id: string, options: APIOptionProps) => deezerRequest<DeezerTrack>(`/track/${id}`, {}, options);
const fetchAlbum = (id: string, options: APIOptionProps) => deezerRequest<DeezerAlbum>(`/album/${id}`, {}, options);
const fetchArtist = (id: string, options: APIOptionProps) => deezerRequest<DeezerArtist>(`/artist/${id}`, {}, options);

// /album/{id} embeds tracks without track_position/disk_number; /album/{id}/tracks has both.
const fetchAlbumTracks = async (id: string, options: APIOptionProps) =>
    (await deezerRequest<DeezerList<DeezerTrack>>(`/album/${id}/tracks`, { limit: 500 }, options)).data || [];

async function fetchDiscography(artistId: string, options: APIOptionProps): Promise<DeezerAlbum[]> {
    const albums: DeezerAlbum[] = [];
    while (albums.length < MAX_DISCOGRAPHY) {
        const page = await deezerRequest<DeezerList<DeezerAlbum>>(`/artist/${artistId}/albums`, { limit: 100, index: albums.length }, options);
        albums.push(...(page.data || []));
        if (!page.next || !page.data?.length) break;
    }
    return albums;
}

// --- Public API (mirrors qobuz-dl-server signatures) -----------------------

export async function search(query: string, limit: number = 10, offset: number = 0, options: APIOptionProps = {}): Promise<QobuzSearchResults> {
    const empty = { data: [], total: 0 };

    // Pasted deezer.com URLs resolve to a single targeted result.
    const urlMatch = matchDeezerUrl(query);
    if (urlMatch) {
        if (urlMatch.kind === 'albums')
            return normalizeDeezerSearch(query, limit, offset, { data: [await fetchAlbum(urlMatch.id, options)], total: 1 }, empty, empty, 'albums');
        if (urlMatch.kind === 'artists')
            return normalizeDeezerSearch(query, limit, offset, empty, empty, { data: [await fetchArtist(urlMatch.id, options)], total: 1 }, 'artists');
        return normalizeDeezerSearch(query, limit, offset, empty, { data: [await fetchTrack(urlMatch.id, options)], total: 1 }, empty, 'tracks');
    }

    // Deezer searches one type per endpoint, so fan out and merge into one result.
    const params = { q: query, limit, index: offset };
    const [albums, tracks, artists] = await Promise.all([
        deezerRequest<DeezerList<DeezerAlbum>>('/search/album', params, options),
        deezerRequest<DeezerList<DeezerTrack>>('/search/track', params, options),
        deezerRequest<DeezerList<DeezerArtist>>('/search/artist', params, options)
    ]);
    return normalizeDeezerSearch(query, limit, offset, albums, tracks, artists);
}

export async function getAlbumInfo(album_id: string, options: APIOptionProps = {}): Promise<FetchedQobuzAlbum> {
    const [album, tracks] = await Promise.all([fetchAlbum(album_id, options), fetchAlbumTracks(album_id, options)]);
    return normalizeDeezerAlbumFull(album, tracks);
}

// Returns the already-parsed inner `artist` object, like the Apple client, so the
// route can wrap it as { data: { artist } }. The whole discography is fetched up
// front (bucketed by record_type), so every bucket reports has_more: false.
export async function getArtist(artist_id: string, options: APIOptionProps = {}): Promise<QobuzArtistResults['artist']> {
    const [artist, top, albums] = await Promise.all([
        fetchArtist(artist_id, options),
        deezerRequest<DeezerList<DeezerTrack>>(`/artist/${artist_id}/top`, { limit: 10 }, options),
        fetchDiscography(artist_id, options)
    ]);
    return parseDeezerArtistData(artist, top.data || [], albums).artist;
}

export async function getArtistReleases(
    artist_id: string,
    release_type: string = 'album',
    limit: number = 10,
    offset: number = 0,
    options: APIOptionProps = {}
) {
    // Deezer can't filter by release type server-side, so filter the discography here.
    const [artist, albums] = await Promise.all([fetchArtist(artist_id, options), fetchDiscography(artist_id, options)]);
    const matching = albums.filter((album) => deezerReleaseBucket(album.record_type) === release_type);
    return {
        items: matching.slice(offset, offset + limit).map((album) => normalizeDeezerAlbum(album, artist)),
        has_more: offset + limit < matching.length
    };
}

// Preview URLs carry a short-lived signed token, so always fetch a fresh one.
export async function getPreviewURL(track_id: string, options: APIOptionProps = {}): Promise<string | null> {
    return (await fetchTrack(track_id, options)).preview || null;
}
