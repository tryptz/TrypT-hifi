import axios from 'axios';
import {
    TidalAlbum,
    TidalArtist,
    TidalPage,
    TidalTrack,
    matchTidalUrl,
    normalizeTidalAlbum,
    normalizeTidalAlbumFull,
    normalizeTidalSearch,
    parseTidalArtistData,
    tidalReleaseBucket
} from './tidal';
import { APIOptionProps, FetchedQobuzAlbum, QobuzArtistResults, QobuzSearchResults } from './qobuz-dl';
import { HifiError, hifiApi, nativeTidalConfigured } from './tidal-native-server';

// ---------------------------------------------------------------------------
// Server-only TIDAL client, backed by a HiFi API.
//
// Counterpart to lib/deezer-server.tsx. Do NOT import this into the client.
//
//   - With TIDAL_CLIENT_ID / TIDAL_CLIENT_SECRET / TIDAL_REFRESH_TOKEN set, the
//     HiFi API is this deployment's own (lib/tidal-native-server.ts), answered
//     in-process with its TIDAL account. That takes precedence over:
//   - TIDAL_API_BASE, one or more external HiFi API instance URLs (comma-separated).
//     Requests start on a random instance and fail over on 429 / 5xx / HTML responses.
//   - Instances wrap payloads as { version, data }; unwrap() strips that so the
//     normalizers see the bare TIDAL resource either way.
//   - Stream manifests are decoded in lib/tidal-stream-server.ts (stereo) and
//     lib/tidal-atmos-server.ts (Dolby Atmos).
// ---------------------------------------------------------------------------

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

// Upper bound on album tracklists / discographies we page through.
const MAX_ITEMS = 500;
const PAGE_SIZE = 100;

function instances(): string[] {
    const list = (process.env.TIDAL_API_BASE || '')
        .split(',')
        .map((url) => url.trim().replace(/\/$/, ''))
        .filter(Boolean);
    if (list.length === 0)
        throw new Error(
            'TIDAL is not configured: set TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET and TIDAL_REFRESH_TOKEN (your own account), or TIDAL_API_BASE (an external HiFi API instance).'
        );
    return list;
}

function proxyAgent() {
    if (process.env.SOCKS5_PROXY) return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    return undefined;
}

// How long to wait on an instance's playback queue before giving up on it.
const PLAYBACK_QUEUE_TIMEOUT_S = 60;

async function getJSON(url: string, agent: unknown, requestOptions: object): Promise<{ status: number; body: any; retryAfter: number }> {
    const response = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        // Keep the body as text so an HTML error page can be told apart from JSON.
        responseType: 'text',
        transformResponse: (data) => data,
        ...requestOptions
    });
    const text = String(response.data).trimStart();
    // A misconfigured URL (e.g. a SPA root) answers every path with index.html.
    if (text.startsWith('<')) throw new Error(`TIDAL instance ${new URL(url).origin} returned HTML instead of JSON`);
    const retryAfter = Math.min(Math.max(Number(response.headers['retry-after']) || 1, 1), 10);
    return { status: response.status, body: JSON.parse(text), retryAfter };
}

// The deployment's own HiFi API, called in-process: same paths and bodies as over HTTP.
async function nativeRequest<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) query.append(key, String(value));
    }
    try {
        return (await hifiApi(path, query)) as T;
    } catch (error) {
        if (error instanceof HifiError) throw new Error(`TIDAL: ${error.message} (HTTP ${error.status}) for ${path}`);
        throw error;
    }
}

export async function tidalRequest<T = any>(path: string, params: Record<string, string | number | undefined> = {}, options: APIOptionProps = {}): Promise<T> {
    const { country, ...requestOptions } = options;
    void country; // the instance's own TIDAL session decides the region
    if (nativeTidalConfigured()) return nativeRequest<T>(path, params);
    const bases = instances();
    const agent = proxyAgent();
    const start = Math.floor(Math.random() * bases.length);
    let lastError: unknown;

    for (let attempt = 0; attempt < bases.length; attempt++) {
        const url = new URL(bases[(start + attempt) % bases.length] + path);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
        }
        try {
            let { status, body, retryAfter } = await getJSON(url.toString(), agent, requestOptions);
            // Playback endpoints answer 202 + { statusUrl } when every account on the
            // instance is busy; poll the queued job on that same instance until it resolves.
            for (let waited = 0; status === 202 && body?.statusUrl; waited += retryAfter) {
                if (waited >= PLAYBACK_QUEUE_TIMEOUT_S) throw new Error(`TIDAL instance ${url.origin} kept the request queued for ${waited}s`);
                await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
                ({ status, body, retryAfter } = await getJSON(url.origin + body.statusUrl, agent, requestOptions));
            }
            return body as T;
        } catch (error: any) {
            lastError = error;
            const status = error?.response?.status;
            // 4xx other than 401/429 means the request itself is bad (e.g. unknown id): don't retry it elsewhere.
            if (status && status < 500 && status !== 401 && status !== 429) break;
        }
    }
    const status = (lastError as any)?.response?.status;
    throw new Error(`TIDAL: ${status ? `HTTP ${status}` : (lastError as Error)?.message || 'all instances failed'} for ${path}`);
}

// --- Response unwrapping ---------------------------------------------------

// Instances answer { version, data: X }; older ones answer X directly.
const unwrap = (body: any) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

// Search answers either a bare page, or { albums: page, tracks: page, ... } when
// the instance runs a multi-type TIDAL search.
function pageOf<T>(body: any, key: 'albums' | 'tracks' | 'artists'): TidalPage<T> {
    const data = unwrap(body);
    const page = Array.isArray(data?.items) ? data : data?.[key];
    return { items: page?.items || [], totalNumberOfItems: page?.totalNumberOfItems, limit: page?.limit, offset: page?.offset };
}

// Album tracklists are { item: track, type } wrappers on some instances and bare tracks on others.
const albumTrackItems = (data: any): TidalTrack[] =>
    ((data?.tracks?.items ?? data?.items ?? []) as any[]).map((entry) => entry?.item ?? entry).filter((t) => t && t.id);

// --- Low-level fetches -----------------------------------------------------

const fetchTrack = async (id: string, options: APIOptionProps) => unwrap(await tidalRequest('/info/', { id }, options)) as TidalTrack;

const fetchArtist = async (id: string, options: APIOptionProps): Promise<TidalArtist> => {
    const body = await tidalRequest('/artist/', { id }, options);
    return (body?.artist ?? unwrap(body)?.artist ?? unwrap(body)) as TidalArtist;
};

async function fetchAlbumWithTracks(id: string, options: APIOptionProps): Promise<{ album: TidalAlbum; tracks: TidalTrack[] }> {
    const first = unwrap(await tidalRequest('/album/', { id }, options));
    const album = (first?.album ?? first) as TidalAlbum;
    const tracks = albumTrackItems(first);
    const total = Math.min(first?.tracks?.totalNumberOfItems ?? album.numberOfTracks ?? tracks.length, MAX_ITEMS);
    while (tracks.length < total) {
        const page = albumTrackItems(unwrap(await tidalRequest('/album/', { id, offset: tracks.length, limit: PAGE_SIZE }, options)));
        if (page.length === 0) break;
        tracks.push(...page);
    }
    return { album, tracks };
}

// /artist/?f= returns the whole discography (albums, EPs and singles) plus top tracks.
async function fetchArtistContent(id: string, options: APIOptionProps): Promise<{ albums: TidalAlbum[]; topTracks: TidalTrack[] }> {
    // skip_tracks swaps the (slow) every-track-of-every-album aggregation for the artist's real top tracks.
    const body = await tidalRequest('/artist/', { f: id, skip_tracks: 'true' }, options);
    const data = body?.albums || body?.tracks ? body : unwrap(body);
    const albums: TidalAlbum[] = data?.albums?.items ?? (Array.isArray(data?.items) ? data.items : []);
    const rawTracks = data?.topTracks?.items ?? data?.tracks?.items ?? data?.tracks;
    const topTracks: TidalTrack[] = Array.isArray(rawTracks) ? rawTracks : [];
    return { albums: albums.slice(0, MAX_ITEMS), topTracks: topTracks.slice(0, 10) };
}

// --- Public API (mirrors qobuz-dl-server signatures) -----------------------

export async function search(query: string, limit: number = 10, offset: number = 0, options: APIOptionProps = {}): Promise<QobuzSearchResults> {
    const empty = { items: [], totalNumberOfItems: 0 };

    // Pasted tidal.com URLs resolve to a single targeted result.
    const urlMatch = matchTidalUrl(query);
    if (urlMatch) {
        if (urlMatch.kind === 'albums') {
            const { album } = await fetchAlbumWithTracks(urlMatch.id, options);
            return normalizeTidalSearch(query, limit, offset, { items: [album], totalNumberOfItems: 1 }, empty, empty, 'albums');
        }
        if (urlMatch.kind === 'artists')
            return normalizeTidalSearch(
                query,
                limit,
                offset,
                empty,
                empty,
                { items: [await fetchArtist(urlMatch.id, options)], totalNumberOfItems: 1 },
                'artists'
            );
        return normalizeTidalSearch(query, limit, offset, empty, { items: [await fetchTrack(urlMatch.id, options)], totalNumberOfItems: 1 }, empty, 'tracks');
    }

    // The HiFi API searches one type per query key (al / s / a), so fan out and merge.
    const page = { limit, offset };
    const [albums, tracks, artists] = await Promise.all([
        tidalRequest('/search/', { al: query, ...page }, options),
        tidalRequest('/search/', { s: query, ...page }, options),
        tidalRequest('/search/', { a: query, ...page }, options)
    ]);
    return normalizeTidalSearch(
        query,
        limit,
        offset,
        pageOf<TidalAlbum>(albums, 'albums'),
        pageOf<TidalTrack>(tracks, 'tracks'),
        pageOf<TidalArtist>(artists, 'artists')
    );
}

export async function getAlbumInfo(album_id: string, options: APIOptionProps = {}): Promise<FetchedQobuzAlbum> {
    const { album, tracks } = await fetchAlbumWithTracks(album_id, options);
    return normalizeTidalAlbumFull(album, tracks);
}

// Returns the already-parsed inner `artist` object, like the Deezer client, so the
// route can wrap it as { data: { artist } }. The whole discography is fetched up
// front (bucketed by album type), so every bucket reports has_more: false.
export async function getArtist(artist_id: string, options: APIOptionProps = {}): Promise<QobuzArtistResults['artist']> {
    const [artist, { albums, topTracks }] = await Promise.all([fetchArtist(artist_id, options), fetchArtistContent(artist_id, options)]);
    return parseTidalArtistData(artist, topTracks, albums).artist;
}

export async function getArtistReleases(
    artist_id: string,
    release_type: string = 'album',
    limit: number = 10,
    offset: number = 0,
    options: APIOptionProps = {}
) {
    const [artist, { albums }] = await Promise.all([fetchArtist(artist_id, options), fetchArtistContent(artist_id, options)]);
    const matching = albums.filter((album) => tidalReleaseBucket(album.type) === release_type);
    return {
        items: matching.slice(offset, offset + limit).map((album) => normalizeTidalAlbum(album, artist)),
        has_more: offset + limit < matching.length
    };
}
