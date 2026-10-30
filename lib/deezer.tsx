import axios from 'axios';
import { FetchedQobuzAlbum, QobuzAlbum, QobuzArtist, QobuzArtistResults, QobuzSearchResults, QobuzTrack } from './qobuz-dl';

// ---------------------------------------------------------------------------
// Client-safe Deezer layer.
//
// Deezer counterpart to lib/apple-music.tsx. It holds the raw public-API
// (api.deezer.com) resource types and `normalizeDeezer*` adapters that reshape
// them into the existing Qobuz* types, so ReleaseCard / SearchView /
// artist-dialog / the player are reused unchanged.
//
// The public API needs no key but only exposes 30-second MP3 previews, so the
// Deezer source is catalog browsing + preview playback. Full-length Deezer
// streams are encrypted and are deliberately not handled here.
// ---------------------------------------------------------------------------

// --- Raw Deezer API shapes -------------------------------------------------

export type DeezerArtist = {
    id: number;
    name: string;
    link?: string;
    picture_small?: string;
    picture_medium?: string;
    picture_big?: string;
    picture_xl?: string;
    nb_album?: number;
    nb_fan?: number;
};

export type DeezerAlbum = {
    id: number;
    title: string;
    link?: string;
    upc?: string;
    cover_small?: string;
    cover_medium?: string;
    cover_big?: string;
    cover_xl?: string;
    md5_image?: string;
    genre_id?: number;
    genres?: { data: { id: number; name: string }[] };
    label?: string;
    nb_tracks?: number;
    duration?: number;
    release_date?: string;
    record_type?: 'album' | 'single' | 'ep' | 'compile' | string;
    explicit_lyrics?: boolean;
    contributors?: (DeezerArtist & { role?: string })[];
    artist?: DeezerArtist;
    tracks?: { data: DeezerTrack[] };
};

export type DeezerTrack = {
    id: number;
    readable?: boolean;
    title: string;
    title_short?: string;
    title_version?: string;
    isrc?: string;
    link?: string;
    duration: number;
    track_position?: number;
    disk_number?: number;
    release_date?: string;
    explicit_lyrics?: boolean;
    preview?: string;
    md5_image?: string;
    contributors?: (DeezerArtist & { role?: string })[];
    artist: DeezerArtist;
    album?: DeezerAlbum;
};

export type DeezerList<T> = { data: T[]; total?: number; next?: string };

// Deezer answers most failures with HTTP 200 and this body instead of a status code.
export type DeezerError = { error: { type: string; message: string; code: number } };

// --- Deezer-native extras carried alongside the normalized Qobuz shapes -----
// Attached as an optional `deezer` property so existing Qobuz consumers ignore
// it while the player can tell a Deezer track apart and route it correctly.

export type DeezerExtras = {
    id: number;
    link: string | null;
    // Deezer detected AI-generated tracks on this album (set server-side by
    // lib/deezer-ai-server.ts when DEEZER_ARL is set).
    ai?: boolean;
};

export type DeezerTrackExtras = DeezerExtras & { hasPreview: boolean };

export const isDeezerItem = (item: unknown): boolean => Boolean((item as { deezer?: DeezerExtras } | null)?.deezer);

// Deezer flagged this album, or a track's album, as AI-generated.
export const isDeezerAI = (item: unknown): boolean => {
    const o = item as { deezer?: DeezerExtras; album?: { deezer?: DeezerExtras } } | null;
    return Boolean(o?.deezer?.ai || o?.album?.deezer?.ai);
};

// --- URL detection ---------------------------------------------------------
// www.deezer.com/{lang}/album/{id}   (the language segment is optional)
// www.deezer.com/{lang}/track/{id}
// www.deezer.com/{lang}/artist/{id}
// Short links (deezer.page.link / link.deezer.com) are redirects and are not resolved.

export const DEEZER_URL_REGEX = /https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(album|track|artist)\/(\d+)/i;

export type DeezerUrlMatch = { kind: 'albums' | 'artists' | 'tracks'; id: string } | null;

export function matchDeezerUrl(query: string): DeezerUrlMatch {
    const match = query.trim().match(DEEZER_URL_REGEX);
    if (!match) return null;
    const kind = match[1].toLowerCase();
    return { kind: kind === 'album' ? 'albums' : kind === 'artist' ? 'artists' : 'tracks', id: match[2] };
}

// --- Helpers ---------------------------------------------------------------

// Cover URLs are built from the image hash, which lets us ask the CDN for sizes
// the API doesn't list (the largest listed, cover_xl, is only 1000px).
function coverFromHash(md5: string | undefined, size: number): string {
    return md5 ? `https://cdn-images.dzcdn.net/images/cover/${md5}/${size}x${size}-000000-80-0-0.jpg` : '';
}

function toQobuzImage(album?: DeezerAlbum | null, md5Fallback?: string): QobuzAlbum['image'] {
    const md5 = album?.md5_image || md5Fallback;
    return {
        small: album?.cover_medium || coverFromHash(md5, 250),
        thumbnail: album?.cover_big || coverFromHash(md5, 500),
        large: coverFromHash(md5, 1200) || album?.cover_xl || '',
        back: null
    };
}

function toQobuzArtistImage(artist?: DeezerArtist | null): QobuzArtist['image'] {
    if (!artist?.picture_medium) return null;
    return {
        small: artist.picture_small || artist.picture_medium,
        medium: artist.picture_medium,
        large: artist.picture_big || artist.picture_medium,
        extralarge: artist.picture_xl || artist.picture_big || artist.picture_medium,
        mega: artist.picture_xl || artist.picture_big || artist.picture_medium
    };
}

const toUnix = (date?: string) => (date ? Math.floor(new Date(date).getTime() / 1000) : 0);

// Deezer puts the version in title_version (e.g. "(Remastered)") and also appends
// it to `title`; split it back out so formatTitle() doesn't print it twice.
function splitVersion(track: DeezerTrack): { title: string; version: string | null } {
    const version = track.title_version?.trim().replace(/^\((.*)\)$/, '$1') || null;
    return { title: version ? track.title_short || track.title : track.title, version };
}

// --- Normalizers: Deezer -> Qobuz shapes -----------------------------------

export function normalizeDeezerArtist(artist: DeezerArtist): QobuzArtist & { deezer: DeezerExtras } {
    return {
        image: toQobuzArtistImage(artist),
        name: artist.name,
        id: artist.id,
        albums_count: artist.nb_album ?? 0,
        deezer: { id: artist.id, link: artist.link ?? null }
    };
}

// `fallbackArtist` covers endpoints that omit the album's artist (e.g. /artist/{id}/albums).
export function normalizeDeezerAlbum(album: DeezerAlbum, fallbackArtist?: DeezerArtist): QobuzAlbum & { deezer: DeezerExtras } {
    const artist = album.artist || fallbackArtist;
    const mainArtists = (album.contributors || []).filter((c) => !c.role || c.role === 'Main');
    const artists = mainArtists.length > 0 ? mainArtists : artist ? [artist] : [];
    return {
        // The public API only serves MP3 previews, so no lossless/hi-res badges.
        maximum_bit_depth: 16,
        image: toQobuzImage(album),
        artist: artist ? normalizeDeezerArtist(artist) : { image: null, name: 'Various Artists', id: 0, albums_count: 0 },
        artists: artists.map((a) => ({ id: a.id, name: a.name, roles: ['main-artist'] })),
        released_at: toUnix(album.release_date),
        label: { name: album.label || '', id: 0, albums_count: 0 },
        title: album.title,
        qobuz_id: album.id,
        version: null,
        duration: album.duration ?? 0,
        parental_warning: Boolean(album.explicit_lyrics),
        tracks_count: album.nb_tracks ?? album.tracks?.data?.length ?? 0,
        genre: { path: [], color: '#000000', name: album.genres?.data?.[0]?.name || '', id: album.genre_id ?? 0 },
        id: String(album.id),
        maximum_sampling_rate: 44.1,
        release_date_original: album.release_date || '',
        hires: false,
        upc: album.upc || '',
        streamable: true,
        deezer: { id: album.id, link: album.link ?? null }
    };
}

export function normalizeDeezerTrack(track: DeezerTrack, album?: QobuzAlbum): QobuzTrack & { deezer: DeezerTrackExtras } {
    const { title, version } = splitVersion(track);
    const composer = (track.contributors || []).find((c) => c.role === 'Composer');
    // Track payloads embed a slim album; fall back to the track's own cover hash.
    const resolvedAlbum =
        album || normalizeDeezerAlbum({ ...(track.album || { id: 0, title: '' }), md5_image: track.album?.md5_image || track.md5_image }, track.artist);
    const hasPreview = Boolean(track.preview);
    return {
        isrc: track.isrc || null,
        copyright: '',
        maximum_bit_depth: 16,
        maximum_sampling_rate: 44.1,
        performer: { name: track.artist?.name || '', id: track.artist?.id ?? 0 },
        composer: composer ? { name: composer.name, id: composer.id } : undefined,
        album: resolvedAlbum,
        track_number: track.track_position ?? 0,
        released_at: toUnix(track.release_date || track.album?.release_date),
        title,
        version,
        duration: track.duration ?? 0,
        parental_warning: Boolean(track.explicit_lyrics),
        id: track.id,
        hires: false,
        // Only tracks with a preview can be played; `readable: false` means region-blocked.
        streamable: hasPreview && track.readable !== false,
        media_number: track.disk_number ?? 1,
        deezer: { id: track.id, link: track.link ?? null, hasPreview }
    };
}

export function normalizeDeezerAlbumFull(album: DeezerAlbum, tracks: DeezerTrack[]): FetchedQobuzAlbum {
    const base = normalizeDeezerAlbum(album);
    const items = tracks.map((t, i) => normalizeDeezerTrack({ ...t, track_position: t.track_position ?? i + 1 }, base));
    return {
        ...base,
        tracks: { offset: 0, limit: items.length, total: album.nb_tracks ?? items.length, items }
    };
}

type Bucket<T> = { limit: number; offset: number; total: number; items: T[] };

export function normalizeDeezerSearch(
    query: string,
    limit: number,
    offset: number,
    albums: DeezerList<DeezerAlbum>,
    tracks: DeezerList<DeezerTrack>,
    artists: DeezerList<DeezerArtist>,
    switchTo: QobuzSearchResults['switchTo'] = null
): QobuzSearchResults {
    const bucket = <R, T>(list: DeezerList<R>, map: (item: R) => T): Bucket<T> => ({
        limit,
        offset,
        total: list.total ?? offset + list.data.length,
        items: list.data.map(map)
    });
    return {
        query,
        switchTo,
        albums: bucket(albums, (a) => normalizeDeezerAlbum(a)),
        tracks: bucket(tracks, (t) => normalizeDeezerTrack(t)),
        artists: bucket(artists, (a) => normalizeDeezerArtist(a))
    };
}

// Deezer's record_type -> the artist dialog's release buckets. Deezer has no "live" type.
export function deezerReleaseBucket(recordType?: string): keyof QobuzArtistResults['artist']['releases'] {
    if (recordType === 'single' || recordType === 'ep') return 'epSingle';
    if (recordType === 'compile') return 'compilation';
    return 'album';
}

// Shape a Deezer artist + top tracks + discography into what artist-dialog expects.
export function parseDeezerArtistData(artist: DeezerArtist, topTracks: DeezerTrack[], albums: DeezerAlbum[]): QobuzArtistResults {
    const releases: QobuzArtistResults['artist']['releases'] = {
        album: { has_more: false, items: [] },
        live: { has_more: false, items: [] },
        compilation: { has_more: false, items: [] },
        epSingle: { has_more: false, items: [] }
    };
    for (const album of albums) releases[deezerReleaseBucket(album.record_type)].items.push(normalizeDeezerAlbum(album, artist));
    return {
        artist: {
            id: String(artist.id),
            name: { display: artist.name },
            artist_category: '',
            biography: { content: '', source: null, language: 'en' },
            images: { portrait: { hash: '', format: 'jpg' } },
            top_tracks: topTracks.map((t) => normalizeDeezerTrack(t)),
            releases
        }
    };
}

// Client fetch mirroring getFullAlbumInfo() but hitting the Deezer routes.
export async function getFullDeezerAlbumInfo(
    fetchedAlbumData: FetchedQobuzAlbum | null,
    setFetchedAlbumData: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>,
    result: QobuzAlbum
) {
    if (fetchedAlbumData && fetchedAlbumData.id === result.id) return fetchedAlbumData;
    setFetchedAlbumData(null);
    const albumDataResponse = await axios.get('/api/deezer/get-album', { params: { album_id: result.id } });
    setFetchedAlbumData(albumDataResponse.data.data);
    return albumDataResponse.data.data;
}
