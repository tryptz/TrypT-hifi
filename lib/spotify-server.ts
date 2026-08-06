import axios from 'axios';
import { LIKED_SONGS_ID, SpotifyPlaylist, SpotifyPlaylistSummary, SpotifyTrack, SpotifyUser } from './spotify';

// Functions only to be used by servers
// Do not import this file into the client

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const SPOTIFY_TOKEN_URL = `${(process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com').replace(/\/$/, '')}/api/token`;
const SPOTIFY_API_BASE = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1/';
const SPOTIFY_PAGE_SIZE = 100;

// Playlists can hold thousands of entries; every imported track costs at least
// one Qobuz search, so cap what a single import pulls in.
export const SPOTIFY_IMPORT_LIMIT = Math.max(1, parseInt(process.env.SPOTIFY_IMPORT_LIMIT || '500'));

export function testForSpotifyRequirements() {
    if (!process.env.SPOTIFY_CLIENT_ID || process.env.SPOTIFY_CLIENT_ID.length === 0)
        throw new Error('Deployment is missing SPOTIFY_CLIENT_ID environment variable.');
    if (!process.env.SPOTIFY_CLIENT_SECRET || process.env.SPOTIFY_CLIENT_SECRET.length === 0)
        throw new Error('Deployment is missing SPOTIFY_CLIENT_SECRET environment variable.');
    return true;
}

export function createSpotifyProxyAgent() {
    if (!process.env.SOCKS5_PROXY) return undefined;
    return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getSpotifyAccessToken(): Promise<string> {
    testForSpotifyRequirements();
    // Reuse the client-credentials token until it is close to expiring.
    if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;

    const proxyAgent = createSpotifyProxyAgent();
    const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    try {
        const response = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({ grant_type: 'client_credentials' }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${credentials}`
            },
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });
        cachedToken = {
            value: response.data.access_token,
            expiresAt: Date.now() + (response.data.expires_in ?? 3600) * 1000
        };
        return cachedToken.value;
    } catch (error: any) {
        cachedToken = null;
        if (error?.response?.status === 400 || error?.response?.status === 401)
            throw new Error('Spotify rejected the configured credentials. Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
        throw new Error(`Could not authenticate with Spotify: ${error?.message || 'unknown error'}`);
    }
}

async function spotifyGet(path: string, params: Record<string, string | number>, token: string) {
    const proxyAgent = createSpotifyProxyAgent();
    try {
        const response = await axios.get(new URL(path, SPOTIFY_API_BASE).toString(), {
            params,
            headers: { Authorization: `Bearer ${token}` },
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });
        return response.data;
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 404) throw new Error('That Spotify playlist could not be found. Sign in with Spotify to import your own private playlists.');
        if (status === 401 || status === 403)
            throw new Error(
                'Spotify denied access to that playlist. Sign in with Spotify to import private playlists; algorithmic playlists cannot be imported.'
            );
        if (status === 429) throw new Error('Spotify is rate limiting this deployment. Try again in a moment.');
        throw new Error(error?.response?.data?.error?.message || error?.message || 'An error occurred talking to Spotify.');
    }
}

function parseTrack(item: any): SpotifyTrack | null {
    const track = item?.track;
    // Skip removed entries, local files and podcast episodes — none of them can
    // be looked up on Qobuz.
    if (!track || item.is_local || track.is_local) return null;
    if (!track.name || !Array.isArray(track.artists) || track.artists.length === 0) return null;
    return {
        id: track.id || `${track.name}-${track.artists[0]?.name}`,
        title: track.name,
        artists: track.artists.map((artist: any) => artist?.name).filter(Boolean),
        album: track.album?.name || '',
        isrc: track.external_ids?.isrc || null,
        duration: Math.round((track.duration_ms ?? 0) / 1000),
        explicit: !!track.explicit,
        url: track.external_urls?.spotify || null
    };
}

// `userToken` is the signed-in user's access token when there is one, which is
// what makes private and collaborative playlists importable. Without it the
// client-credentials token is used and only public playlists resolve.
export async function getPlaylist(playlistId: string, userToken?: string | null): Promise<SpotifyPlaylist> {
    if (playlistId === LIKED_SONGS_ID) {
        if (!userToken) throw new Error('Sign in with Spotify to import your Liked Songs.');
        return getLikedSongs(userToken);
    }
    const token = userToken || (await getSpotifyAccessToken());

    const playlist = await spotifyGet(
        `playlists/${playlistId}`,
        { fields: 'id,name,description,external_urls(spotify),images,owner(display_name),tracks(total)' },
        token
    );

    const tracks: SpotifyTrack[] = [];
    let offset = 0;
    let fetched = 0;
    while (fetched < SPOTIFY_IMPORT_LIMIT) {
        const page = await spotifyGet(
            `playlists/${playlistId}/tracks`,
            {
                limit: Math.min(SPOTIFY_PAGE_SIZE, SPOTIFY_IMPORT_LIMIT - fetched),
                offset,
                fields: 'next,items(is_local,track(id,name,duration_ms,explicit,is_local,external_ids(isrc),external_urls(spotify),artists(name),album(name)))'
            },
            token
        );
        const items: any[] = page?.items ?? [];
        for (const item of items) {
            const track = parseTrack(item);
            if (track) tracks.push(track);
        }
        fetched += items.length;
        offset += items.length;
        if (!page?.next || items.length === 0) break;
    }

    const total = playlist?.tracks?.total ?? tracks.length;
    return {
        id: playlist.id,
        name: playlist.name || 'Untitled playlist',
        description: playlist.description || '',
        owner: playlist.owner?.display_name || '',
        image: playlist.images?.[0]?.url || null,
        url: playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlistId}`,
        total,
        truncated: total > fetched,
        tracks
    };
}

export async function getCurrentUser(userToken: string): Promise<SpotifyUser> {
    const profile = await spotifyGet('me', {}, userToken);
    return {
        id: profile.id,
        name: profile.display_name || profile.id,
        image: profile.images?.[0]?.url || null,
        url: profile.external_urls?.spotify || null
    };
}

// The signed-in user's own library: their playlists plus the collaborative ones
// they follow. Liked Songs is prepended by the route as a pseudo-playlist.
export async function getUserPlaylists(userToken: string, offset: number = 0, limit: number = 50) {
    const page = await spotifyGet('me/playlists', { limit: Math.min(50, limit), offset }, userToken);
    const items: SpotifyPlaylistSummary[] = (page?.items ?? []).filter(Boolean).map((playlist: any) => ({
        id: playlist.id,
        name: playlist.name || 'Untitled playlist',
        owner: playlist.owner?.display_name || '',
        image: playlist.images?.[0]?.url || null,
        url: playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`,
        total: playlist.tracks?.total ?? 0
    }));
    return { items, total: page?.total ?? items.length, hasMore: !!page?.next };
}

export async function getLikedSongsSummary(userToken: string): Promise<SpotifyPlaylistSummary> {
    const page = await spotifyGet('me/tracks', { limit: 1, offset: 0 }, userToken);
    return {
        id: LIKED_SONGS_ID,
        name: 'Liked Songs',
        owner: '',
        image: null,
        url: 'https://open.spotify.com/collection/tracks',
        total: page?.total ?? 0
    };
}

export async function getLikedSongs(userToken: string): Promise<SpotifyPlaylist> {
    const tracks: SpotifyTrack[] = [];
    let offset = 0;
    let fetched = 0;
    let total = 0;
    // /me/tracks caps out at 50 per page, unlike the 100 playlist tracks allow.
    while (fetched < SPOTIFY_IMPORT_LIMIT) {
        const page = await spotifyGet('me/tracks', { limit: Math.min(50, SPOTIFY_IMPORT_LIMIT - fetched), offset }, userToken);
        const items: any[] = page?.items ?? [];
        total = page?.total ?? total;
        for (const item of items) {
            const track = parseTrack(item);
            if (track) tracks.push(track);
        }
        fetched += items.length;
        offset += items.length;
        if (!page?.next || items.length === 0) break;
    }
    return {
        id: LIKED_SONGS_ID,
        name: 'Liked Songs',
        description: '',
        owner: '',
        image: null,
        url: 'https://open.spotify.com/collection/tracks',
        total: total || tracks.length,
        truncated: (total || tracks.length) > fetched,
        tracks
    };
}
