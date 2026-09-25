import axios from 'axios';
import { FetchedQobuzAlbum, QobuzAlbum, QobuzArtist, QobuzArtistResults, QobuzSearchResults, QobuzTrack } from './qobuz-dl';

// ---------------------------------------------------------------------------
// Client-safe TIDAL layer.
//
// TIDAL counterpart to lib/deezer.tsx. TIDAL is reached through a HiFi API
// instance (the same backend Tryptify's "Tidal HiFi URL" points at), which
// proxies TIDAL's catalog and hands out lossless stream manifests. This file
// holds the raw resource types and `normalizeTidal*` adapters that reshape them
// into the existing Qobuz* types, so ReleaseCard / SearchView / artist-dialog /
// the player / the download pipeline are reused unchanged.
// ---------------------------------------------------------------------------

// --- Raw TIDAL shapes ------------------------------------------------------

export type TidalArtist = {
    id: number;
    name: string;
    picture?: string | null;
    type?: string;
    url?: string;
    artistTypes?: string[];
};

export type TidalAlbum = {
    id: number;
    title: string;
    cover?: string | null;
    url?: string;
    upc?: string;
    type?: 'ALBUM' | 'EP' | 'SINGLE' | 'COMPILATION' | string;
    version?: string | null;
    duration?: number;
    numberOfTracks?: number;
    numberOfVolumes?: number;
    releaseDate?: string;
    copyright?: string;
    explicit?: boolean;
    streamReady?: boolean;
    allowStreaming?: boolean;
    audioQuality?: string;
    mediaMetadata?: { tags?: string[] };
    artist?: TidalArtist;
    artists?: TidalArtist[];
};

export type TidalTrack = {
    id: number;
    title: string;
    version?: string | null;
    duration: number;
    trackNumber?: number;
    volumeNumber?: number;
    isrc?: string;
    url?: string;
    copyright?: string;
    explicit?: boolean;
    streamReady?: boolean;
    allowStreaming?: boolean;
    streamStartDate?: string;
    audioQuality?: string;
    mediaMetadata?: { tags?: string[] };
    artist?: TidalArtist;
    artists?: TidalArtist[];
    album?: Partial<TidalAlbum>;
};

export type TidalPage<T> = { items: T[]; limit?: number; offset?: number; totalNumberOfItems?: number };

// --- TIDAL-native extras carried alongside the normalized Qobuz shapes ------
// Attached as an optional `tidal` property so existing Qobuz consumers ignore
// it while the player and download pipeline can route to /api/tidal/*.

export type TidalExtras = {
    id: number;
    link: string | null;
};

export const isTidalItem = (item: unknown): boolean => Boolean((item as { tidal?: TidalExtras } | null)?.tidal);

// --- URL detection ---------------------------------------------------------
// tidal.com/browse/album/{id}, listen.tidal.com/album/{id}, tidal.com/track/{id} ...
// Tracks shared from an album page look like /album/{a}/track/{t}; the track wins.

export const TIDAL_URL_REGEX = /https?:\/\/(?:listen\.|www\.)?tidal\.com\/(?:browse\/)?(?:album\/\d+\/)?(album|track|artist)\/(\d+)/i;

export type TidalUrlMatch = { kind: 'albums' | 'artists' | 'tracks'; id: string } | null;

export function matchTidalUrl(query: string): TidalUrlMatch {
    const match = query.trim().match(TIDAL_URL_REGEX);
    if (!match) return null;
    const kind = match[1].toLowerCase();
    return { kind: kind === 'album' ? 'albums' : kind === 'artist' ? 'artists' : 'tracks', id: match[2] };
}

// --- Helpers ---------------------------------------------------------------

// TIDAL images are UUIDs; the CDN path is the UUID with dashes turned into slashes.
// Covers come in 80/160/320/640/1280, artist pictures in 160/320/480/750.
export function tidalImage(uuid: string | null | undefined, size: number): string {
    return uuid ? `https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/${size}x${size}.jpg` : '';
}

function toQobuzImage(cover?: string | null): QobuzAlbum['image'] {
    return { small: tidalImage(cover, 320), thumbnail: tidalImage(cover, 640), large: tidalImage(cover, 1280), back: null };
}

function toQobuzArtistImage(picture?: string | null): QobuzArtist['image'] {
    if (!picture) return null;
    return {
        small: tidalImage(picture, 160),
        medium: tidalImage(picture, 320),
        large: tidalImage(picture, 480),
        extralarge: tidalImage(picture, 750),
        mega: tidalImage(picture, 750)
    };
}

const toUnix = (date?: string) => {
    const time = date ? new Date(date).getTime() : NaN;
    return Number.isNaN(time) ? 0 : Math.floor(time / 1000);
};

// Hi-res is only advertised through the media tags; plain LOSSLESS is 16/44.1.
const isHiRes = (item: { audioQuality?: string; mediaMetadata?: { tags?: string[] } }) =>
    item.audioQuality === 'HI_RES_LOSSLESS' || Boolean(item.mediaMetadata?.tags?.includes('HIRES_LOSSLESS'));

const isStreamable = (item: { streamReady?: boolean; allowStreaming?: boolean }) => item.streamReady !== false && item.allowStreaming !== false;

const mainArtist = (item: { artist?: TidalArtist; artists?: TidalArtist[] }) =>
    item.artist || item.artists?.find((a) => !a.type || a.type === 'MAIN') || item.artists?.[0];

// --- Normalizers: TIDAL -> Qobuz shapes ------------------------------------

export function normalizeTidalArtist(artist: TidalArtist): QobuzArtist & { tidal: TidalExtras } {
    return {
        image: toQobuzArtistImage(artist.picture),
        name: artist.name,
        id: artist.id,
        // TIDAL search results carry no release count; ReleaseCard shows it as "0 Releases".
        albums_count: 0,
        tidal: { id: artist.id, link: artist.url ?? `https://tidal.com/browse/artist/${artist.id}` }
    };
}

// `fallbackArtist` covers payloads that omit the album's artist (e.g. embedded track albums).
export function normalizeTidalAlbum(album: Partial<TidalAlbum>, fallbackArtist?: TidalArtist): QobuzAlbum & { tidal: TidalExtras } {
    const artist = mainArtist(album) || fallbackArtist;
    const mainArtists = (album.artists || []).filter((a) => !a.type || a.type === 'MAIN');
    const artists = mainArtists.length > 0 ? mainArtists : artist ? [artist] : [];
    const hires = isHiRes(album);
    const id = album.id ?? 0;
    return {
        maximum_bit_depth: hires ? 24 : 16,
        image: toQobuzImage(album.cover),
        artist: artist ? normalizeTidalArtist(artist) : { image: null, name: 'Various Artists', id: 0, albums_count: 0 },
        artists: artists.map((a) => ({ id: a.id, name: a.name, roles: ['main-artist'] })),
        released_at: toUnix(album.releaseDate),
        label: { name: album.copyright || '', id: 0, albums_count: 0 },
        title: album.title || '',
        qobuz_id: id,
        version: album.version || null,
        duration: album.duration ?? 0,
        parental_warning: Boolean(album.explicit),
        tracks_count: album.numberOfTracks ?? 0,
        // TIDAL has no album genres; the card shows the release type in that slot instead.
        genre: { path: [], color: '#000000', name: album.type ? album.type.toLowerCase() : '', id: 0 },
        id: String(id),
        // TIDAL doesn't expose the exact hi-res rate, so badge it as the common 24/96.
        maximum_sampling_rate: hires ? 96 : 44.1,
        release_date_original: album.releaseDate || '',
        hires,
        upc: album.upc || '',
        streamable: isStreamable(album),
        tidal: { id, link: album.url ?? (id ? `https://tidal.com/browse/album/${id}` : null) }
    };
}

export function normalizeTidalTrack(track: TidalTrack, album?: QobuzAlbum): QobuzTrack & { tidal: TidalExtras } {
    const artist = mainArtist(track);
    const hires = isHiRes(track);
    return {
        isrc: track.isrc || null,
        copyright: track.copyright || '',
        maximum_bit_depth: hires ? 24 : 16,
        maximum_sampling_rate: hires ? 96 : 44.1,
        performer: { name: artist?.name || '', id: artist?.id ?? 0 },
        // Track payloads embed a slim album (id, title, cover); the track's artist stands in for its artist.
        album: album || normalizeTidalAlbum(track.album || {}, artist),
        track_number: track.trackNumber ?? 0,
        released_at: toUnix(track.streamStartDate || track.album?.releaseDate),
        title: track.title,
        version: track.version || null,
        duration: track.duration ?? 0,
        parental_warning: Boolean(track.explicit),
        id: track.id,
        hires,
        streamable: isStreamable(track),
        media_number: track.volumeNumber ?? 1,
        tidal: { id: track.id, link: track.url ?? `https://tidal.com/browse/track/${track.id}` }
    };
}

export function normalizeTidalAlbumFull(album: TidalAlbum, tracks: TidalTrack[]): FetchedQobuzAlbum {
    const base = normalizeTidalAlbum(album);
    const items = tracks.map((t, i) => normalizeTidalTrack({ ...t, trackNumber: t.trackNumber ?? i + 1 }, base));
    return {
        ...base,
        tracks_count: base.tracks_count || items.length,
        tracks: { offset: 0, limit: items.length, total: album.numberOfTracks ?? items.length, items }
    };
}

type Bucket<T> = { limit: number; offset: number; total: number; items: T[] };

export function normalizeTidalSearch(
    query: string,
    limit: number,
    offset: number,
    albums: TidalPage<TidalAlbum>,
    tracks: TidalPage<TidalTrack>,
    artists: TidalPage<TidalArtist>,
    switchTo: QobuzSearchResults['switchTo'] = null
): QobuzSearchResults {
    const bucket = <R, T>(page: TidalPage<R>, map: (item: R) => T): Bucket<T> => ({
        limit,
        offset,
        total: page.totalNumberOfItems ?? offset + page.items.length,
        items: page.items.map(map)
    });
    return {
        query,
        switchTo,
        albums: bucket(albums, (a) => normalizeTidalAlbum(a)),
        tracks: bucket(tracks, (t) => normalizeTidalTrack(t)),
        artists: bucket(artists, (a) => normalizeTidalArtist(a))
    };
}

// TIDAL's album type -> the artist dialog's release buckets. TIDAL has no "live" type.
export function tidalReleaseBucket(type?: string): keyof QobuzArtistResults['artist']['releases'] {
    if (type === 'EP' || type === 'SINGLE') return 'epSingle';
    if (type === 'COMPILATION') return 'compilation';
    return 'album';
}

// Shape a TIDAL artist + top tracks + discography into what artist-dialog expects.
export function parseTidalArtistData(artist: TidalArtist, topTracks: TidalTrack[], albums: TidalAlbum[]): QobuzArtistResults {
    const releases: QobuzArtistResults['artist']['releases'] = {
        album: { has_more: false, items: [] },
        live: { has_more: false, items: [] },
        compilation: { has_more: false, items: [] },
        epSingle: { has_more: false, items: [] }
    };
    for (const album of albums) releases[tidalReleaseBucket(album.type)].items.push(normalizeTidalAlbum(album, artist));
    return {
        artist: {
            id: String(artist.id),
            name: { display: artist.name },
            artist_category: '',
            biography: { content: '', source: null, language: 'en' },
            images: { portrait: { hash: '', format: 'jpg' } },
            top_tracks: topTracks.map((t) => normalizeTidalTrack(t)),
            releases
        }
    };
}

// Client fetch mirroring getFullAlbumInfo() but hitting the TIDAL routes.
export async function getFullTidalAlbumInfo(
    fetchedAlbumData: FetchedQobuzAlbum | null,
    setFetchedAlbumData: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>,
    result: QobuzAlbum
) {
    if (fetchedAlbumData && fetchedAlbumData.id === result.id) return fetchedAlbumData;
    setFetchedAlbumData(null);
    const albumDataResponse = await axios.get('/api/tidal/get-album', { params: { album_id: result.id } });
    setFetchedAlbumData(albumDataResponse.data.data);
    return albumDataResponse.data.data;
}
