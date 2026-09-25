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
        const response = await axios.get(target, { httpAgent: agent, httpsAgent: agent, ...requestOptions });
        const error = (response.data as DeezerError)?.error;
        if (!error) return response.data as T;
        if (error.code === QUOTA_EXCEEDED && attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
            continue;
        }
        throw new Error(`Deezer: ${error.message || error.type} (code ${error.code})`);
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
