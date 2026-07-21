import axios from 'axios';
import { FetchedQobuzAlbum, QobuzAlbum, QobuzArtist, QobuzArtistResults, QobuzSearchResults, QobuzTrack } from './qobuz-dl';

// ---------------------------------------------------------------------------
// Client-safe Apple Music layer.
//
// This module is the Apple counterpart to lib/qobuz-dl.tsx. It holds:
//   1. the raw Apple Music API resource types,
//   2. the download-job manifest contract (the handoff to the native Tryptify
//      app, which does the FairPlay decryption + Dolby Atmos rendering), and
//   3. `normalizeApple*` adapters that reshape Apple responses into the existing
//      Qobuz* types so the whole UI (ReleaseCard / SearchView / artist-dialog /
//      download-job) is reused unchanged.
//
// trypt-hifi never decrypts and never renders Atmos — it only produces metadata
// and a manifest. See docs/apple-music-atmos-in-tryptify.md.
// ---------------------------------------------------------------------------

// --- Raw Apple Music API shapes -------------------------------------------

export type AppleArtwork = {
    url: string; // templated, contains {w}x{h}
    width: number;
    height: number;
    bgColor?: string;
    textColor1?: string;
};

export type AppleResource<Attr, Rel = Record<string, unknown>> = {
    id: string;
    type: string;
    href?: string;
    attributes: Attr;
    relationships?: Rel;
};

export type AppleSongAttributes = {
    name: string;
    artistName: string;
    albumName: string;
    composerName?: string;
    durationInMillis: number;
    trackNumber?: number;
    discNumber?: number;
    releaseDate?: string;
    isrc?: string;
    genreNames: string[];
    contentRating?: 'explicit' | 'clean';
    artwork: AppleArtwork;
    previews?: { url: string }[];
    hasLyrics?: boolean;
    audioTraits?: string[];
    url?: string;
    extendedAssetUrls?: { enhancedHls?: string; plus?: string; superMusicVideo?: string };
    playParams?: { id: string; kind: string };
};

export type AppleAlbumAttributes = {
    name: string;
    artistName: string;
    artwork: AppleArtwork;
    releaseDate?: string;
    trackCount: number;
    genreNames: string[];
    recordLabel?: string;
    copyright?: string;
    upc?: string;
    isSingle?: boolean;
    isCompilation?: boolean;
    isComplete?: boolean;
    contentRating?: 'explicit' | 'clean';
    audioTraits?: string[];
    url?: string;
    editorialNotes?: { standard?: string; short?: string };
};

export type AppleArtistAttributes = {
    name: string;
    genreNames?: string[];
    artwork?: AppleArtwork;
    url?: string;
    editorialNotes?: { standard?: string; short?: string };
};

export type AppleSong = AppleResource<
    AppleSongAttributes,
    { albums?: { data: AppleAlbum[] }; artists?: { data: AppleArtist[] } }
> & { type: 'songs' };

export type AppleAlbum = AppleResource<
    AppleAlbumAttributes,
    { tracks?: { data: AppleSong[]; next?: string }; artists?: { data: AppleArtist[] } }
> & { type: 'albums' };

export type AppleArtist = AppleResource<
    AppleArtistAttributes,
    { albums?: { data: AppleAlbum[]; next?: string } }
> & {
    type: 'artists';
    views?: {
        'top-songs'?: { data: AppleSong[] };
        'full-albums'?: { data: AppleAlbum[]; next?: string };
    };
};

export type AppleSearchResponse = {
    results: {
        songs?: { data: AppleSong[]; next?: string };
        albums?: { data: AppleAlbum[]; next?: string };
        artists?: { data: AppleArtist[]; next?: string };
    };
    meta?: Record<string, unknown>;
};

// --- Apple-native extras carried alongside the normalized Qobuz shapes -----
// Attached as an optional `apple` property so existing Qobuz consumers ignore it
// while the download layer can read the fields it needs.

export type AppleTrackExtras = {
    adamId: string; // Apple catalog song id (authoritative, string)
    storefront?: string;
    audioTraits: string[];
    hasLyrics: boolean;
    previewUrl: string | null;
    contentRating: 'explicit' | 'clean' | null;
    artworkTemplate: string | null;
};

export type AppleAlbumExtras = {
    adamId: string;
    storefront?: string;
    audioTraits: string[];
    contentRating: 'explicit' | 'clean' | null;
    artworkTemplate: string | null;
};

export type AppleQuality = 'alac' | 'hires-lossless' | 'atmos' | 'aac';

// --- Download-job manifest: the trypt-hifi -> Tryptify contract -------------

export type AppleStreamVariant = {
    codecId: string; // e.g. 'audio-alac-stereo-48000-24' | 'audio-atmos' | 'audio-stereo-256'
    codec: string; // e.g. 'alac' | 'ec-3' | 'ac-3' | 'mp4a.40.2'
    channels: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    bandwidth: number | null;
    mediaPlaylistUrl: string | null;
    keyUri: string | null; // the skd:// key id, if exposed by the media playlist
};

export type DownloadJobManifest = {
    version: 1;
    source: 'apple-music';
    storefront: string;
    quality: AppleQuality;
    track: {
        adamId: string;
        isrc: string | null;
        title: string;
        artist: string;
        album: string;
        albumAdamId: string | null;
        trackNumber: number | null;
        discNumber: number | null;
        durationMs: number;
        contentRating: 'explicit' | 'clean' | null;
        copyright: string | null;
        releaseDate: string | null;
        genreNames: string[];
    };
    artwork: {
        urlTemplate: string | null;
        maxWidth: number | null;
        maxHeight: number | null;
        resolved: string | null;
    };
    audioTraits: string[];
    m3u8: {
        masterUrl: string | null;
        source: 'web-extendedAssetUrls' | 'wrapper-device' | null;
        deviceOnly: boolean; // true when the hi-res/atmos master could not be reached web-side or via a local wrapper
    };
    chosenVariant: AppleStreamVariant | null;
    variantTable: AppleStreamVariant[];
    license: {
        licenseServerUrl: string;
        keySystem: 'com.apple.fps';
        requiresWrapper: true;
    };
    lyrics: {
        available: boolean;
        ttml: string | null;
    };
    previewUrl: string | null;
    // Explicit boundary flags telling Tryptify which stages it must perform.
    requiresWrapper: {
        m3u8: boolean;
        license: true;
        decrypt: true;
        atmosRender: boolean;
    };
    createdAt: number;
    sig?: string; // optional HMAC integrity signature over the manifest
};

// --- URL detection ---------------------------------------------------------
// music.apple.com/{storefront}/album/{slug}/{id}            -> album (id is trailing digits)
// music.apple.com/{storefront}/album/{slug}/{id}?i={songId} -> song  (?i= wins)
// music.apple.com/{storefront}/artist/{slug}/{id}           -> artist
// music.apple.com/{storefront}/song/{slug}/{id}             -> song

export const APPLE_ALBUM_URL_REGEX = /https?:\/\/music\.apple\.com\/[a-z]{2}\/album\/[^/]+\/(\d+)/i;
export const APPLE_ARTIST_URL_REGEX = /https?:\/\/music\.apple\.com\/[a-z]{2}\/artist\/[^/]+\/(\d+)/i;
export const APPLE_SONG_URL_REGEX = /https?:\/\/music\.apple\.com\/[a-z]{2}\/song\/[^/]+\/(\d+)/i;
export const APPLE_SONG_QUERY_REGEX = /[?&]i=(\d+)/;

export type AppleUrlMatch = { kind: 'albums' | 'artists' | 'tracks'; id: string } | null;

export function matchAppleUrl(query: string): AppleUrlMatch {
    const q = query.trim();
    const songQuery = q.match(APPLE_SONG_QUERY_REGEX);
    if (songQuery && APPLE_ALBUM_URL_REGEX.test(q)) return { kind: 'tracks', id: songQuery[1] };
    const song = q.match(APPLE_SONG_URL_REGEX);
    if (song) return { kind: 'tracks', id: song[1] };
    const album = q.match(APPLE_ALBUM_URL_REGEX);
    if (album) return { kind: 'albums', id: album[1] };
    const artist = q.match(APPLE_ARTIST_URL_REGEX);
    if (artist) return { kind: 'artists', id: artist[1] };
    return null;
}

// --- Helpers ---------------------------------------------------------------

// Resolve an Apple artwork URL template ({w}x{h}) at a given square size.
export function templateArtwork(url: string | undefined | null, size: number): string {
    if (!url) return '';
    return url
        .replace('{w}', String(size))
        .replace('{h}', String(size))
        .replace('{c}', 'bb')
        .replace('{f}', 'jpg');
}

function toQobuzImage(artwork?: AppleArtwork | null): QobuzAlbum['image'] {
    return {
        small: templateArtwork(artwork?.url, 200),
        thumbnail: templateArtwork(artwork?.url, 400),
        large: templateArtwork(artwork?.url, 1200),
        back: null
    };
}

function toQobuzArtistImage(artwork?: AppleArtwork | null): QobuzArtist['image'] {
    if (!artwork?.url) return null;
    return {
        small: templateArtwork(artwork.url, 200),
        medium: templateArtwork(artwork.url, 400),
        large: templateArtwork(artwork.url, 600),
        extralarge: templateArtwork(artwork.url, 1200),
        mega: templateArtwork(artwork.url, 2400)
    };
}

const hasTrait = (traits: string[] | undefined, needle: string) =>
    (traits || []).some((t) => t.toLowerCase().includes(needle));

// A number > 2 lights up the multichannel/spatial affordances in the UI.
function channelCountFromTraits(traits?: string[]): number | undefined {
    if (hasTrait(traits, 'atmos') || hasTrait(traits, 'spatial')) return 6;
    return undefined;
}

function numericId(adamId: string): number {
    const n = Number(adamId);
    return Number.isSafeInteger(n) ? n : 0;
}

// --- Normalizers: Apple -> Qobuz shapes ------------------------------------

export function normalizeAppleAlbum(album: AppleAlbum, storefront?: string): QobuzAlbum & { apple: AppleAlbumExtras } {
    const a = album.attributes;
    const traits = a.audioTraits || [];
    const releasedAt = a.releaseDate ? Math.floor(new Date(a.releaseDate).getTime() / 1000) : 0;
    return {
        maximum_bit_depth: hasTrait(traits, 'hi-res') ? 24 : 16,
        maximum_channel_count: channelCountFromTraits(traits),
        image: toQobuzImage(a.artwork),
        artist: {
            image: null,
            name: a.artistName,
            id: 0,
            albums_count: 0
        },
        artists: [{ id: 0, name: a.artistName, roles: ['main-artist'] }],
        released_at: releasedAt,
        label: { name: a.recordLabel || '', id: 0, albums_count: 0 },
        title: a.name,
        qobuz_id: numericId(album.id),
        version: null,
        duration: 0,
        parental_warning: a.contentRating === 'explicit',
        tracks_count: a.trackCount,
        genre: { path: [], color: '#000000', name: (a.genreNames && a.genreNames[0]) || '', id: 0 },
        id: album.id,
        maximum_sampling_rate: hasTrait(traits, 'hi-res') ? 96 : 44.1,
        release_date_original: a.releaseDate || '',
        hires: hasTrait(traits, 'hi-res'),
        upc: a.upc || '',
        streamable: true,
        apple: {
            adamId: album.id,
            storefront,
            audioTraits: traits,
            contentRating: a.contentRating ?? null,
            artworkTemplate: a.artwork?.url ?? null
        }
    };
}

// Build a minimal QobuzAlbum from a song's own attributes (Apple song artwork IS
// the album artwork), used when a full album object is not embedded.
function stubAlbumFromSong(song: AppleSong): QobuzAlbum {
    const a = song.attributes;
    const traits = a.audioTraits || [];
    const albumId = song.relationships?.albums?.data?.[0]?.id || '';
    return {
        maximum_bit_depth: hasTrait(traits, 'hi-res') ? 24 : 16,
        maximum_channel_count: channelCountFromTraits(traits),
        image: toQobuzImage(a.artwork),
        artist: { image: null, name: a.artistName, id: 0, albums_count: 0 },
        artists: [{ id: 0, name: a.artistName, roles: ['main-artist'] }],
        released_at: a.releaseDate ? Math.floor(new Date(a.releaseDate).getTime() / 1000) : 0,
        label: { name: '', id: 0, albums_count: 0 },
        title: a.albumName,
        qobuz_id: numericId(albumId),
        version: null,
        duration: 0,
        parental_warning: a.contentRating === 'explicit',
        tracks_count: 0,
        genre: { path: [], color: '#000000', name: (a.genreNames && a.genreNames[0]) || '', id: 0 },
        id: albumId,
        maximum_sampling_rate: hasTrait(traits, 'hi-res') ? 96 : 44.1,
        release_date_original: a.releaseDate || '',
        hires: hasTrait(traits, 'hi-res'),
        upc: '',
        streamable: true
    };
}

export function normalizeAppleSong(
    song: AppleSong,
    album?: QobuzAlbum,
    storefront?: string
): QobuzTrack & { apple: AppleTrackExtras } {
    const a = song.attributes;
    const traits = a.audioTraits || [];
    return {
        isrc: a.isrc || null,
        copyright: '',
        maximum_bit_depth: hasTrait(traits, 'hi-res') ? 24 : 16,
        maximum_sampling_rate: hasTrait(traits, 'hi-res') ? 96 : 44.1,
        maximum_channel_count: channelCountFromTraits(traits),
        performer: { name: a.artistName, id: 0 },
        composer: a.composerName ? { name: a.composerName, id: 0 } : undefined,
        album: album || stubAlbumFromSong(song),
        track_number: a.trackNumber ?? 0,
        released_at: a.releaseDate ? Math.floor(new Date(a.releaseDate).getTime() / 1000) : 0,
        title: a.name,
        version: null,
        duration: Math.round((a.durationInMillis || 0) / 1000),
        parental_warning: a.contentRating === 'explicit',
        id: numericId(song.id),
        hires: hasTrait(traits, 'hi-res'),
        streamable: true,
        media_number: a.discNumber ?? 1,
        apple: {
            adamId: song.id,
            storefront,
            audioTraits: traits,
            hasLyrics: Boolean(a.hasLyrics),
            previewUrl: a.previews?.[0]?.url ?? null,
            contentRating: a.contentRating ?? null,
            artworkTemplate: a.artwork?.url ?? null
        }
    };
}

export function normalizeAppleAlbumFull(album: AppleAlbum, storefront?: string): FetchedQobuzAlbum {
    const base = normalizeAppleAlbum(album, storefront);
    const tracks = album.relationships?.tracks?.data || [];
    const items = tracks.map((t) => normalizeAppleSong(t, base, storefront));
    return {
        ...base,
        tracks: {
            offset: 0,
            limit: items.length,
            total: album.attributes.trackCount || items.length,
            items
        }
    };
}

export function normalizeAppleArtist(artist: AppleArtist): QobuzArtist & { apple: { adamId: string } } {
    return {
        image: toQobuzArtistImage(artist.attributes.artwork),
        name: artist.attributes.name,
        id: numericId(artist.id),
        albums_count: artist.relationships?.albums?.data?.length ?? artist.views?.['full-albums']?.data?.length ?? 0,
        apple: { adamId: artist.id }
    };
}

export function normalizeAppleSearch(
    response: AppleSearchResponse,
    query: string,
    limit: number,
    offset: number,
    switchTo: QobuzSearchResults['switchTo'] = null,
    storefront?: string
): QobuzSearchResults {
    const albums = response.results.albums?.data || [];
    const songs = response.results.songs?.data || [];
    const artists = response.results.artists?.data || [];
    // Apple never returns a grand total; synthesize one that keeps the UI's
    // "load more" / skeleton logic working (there is more if `next` is present).
    const synthTotal = (items: number, hasNext: boolean) => offset + items + (hasNext ? limit : 0);
    return {
        query,
        switchTo,
        albums: {
            limit,
            offset,
            total: synthTotal(albums.length, Boolean(response.results.albums?.next)),
            items: albums.map((al) => normalizeAppleAlbum(al, storefront))
        },
        tracks: {
            limit,
            offset,
            total: synthTotal(songs.length, Boolean(response.results.songs?.next)),
            items: songs.map((s) => normalizeAppleSong(s, undefined, storefront))
        },
        artists: {
            limit,
            offset,
            total: synthTotal(artists.length, Boolean(response.results.artists?.next)),
            items: artists.map((ar) => normalizeAppleArtist(ar))
        }
    };
}

// Shape an Apple artist (with views=full-albums,top-songs) into the structure
// parseArtistData()/artist-dialog expect.
export function parseAppleArtistData(artist: AppleArtist, storefront?: string): QobuzArtistResults {
    const topSongs = artist.views?.['top-songs']?.data || [];
    const fullAlbums = artist.views?.['full-albums']?.data || artist.relationships?.albums?.data || [];
    const albumsNormalized = fullAlbums.map((al) => normalizeAppleAlbum(al, storefront));
    const emptyBucket = { has_more: false, items: [] as QobuzAlbum[] };
    return {
        artist: {
            id: artist.id,
            name: { display: artist.attributes.name },
            artist_category: '',
            biography: { content: artist.attributes.editorialNotes?.standard || '', source: null, language: 'en' },
            images: { portrait: { hash: '', format: 'jpg' } },
            top_tracks: topSongs.map((s) => normalizeAppleSong(s, undefined, storefront)),
            releases: {
                // Apple has no album/live/compilation split at this endpoint; place
                // everything under `album` and leave the other buckets empty.
                album: {
                    has_more: Boolean(artist.views?.['full-albums']?.next),
                    items: albumsNormalized
                },
                live: { ...emptyBucket },
                compilation: { ...emptyBucket },
                epSingle: { ...emptyBucket }
            }
        }
    };
}

// Client fetch mirroring getFullAlbumInfo() but hitting the Apple routes.
export async function getFullAppleAlbumInfo(
    fetchedAlbumData: FetchedQobuzAlbum | null,
    setFetchedAlbumData: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>,
    result: QobuzAlbum,
    country?: string
) {
    if (fetchedAlbumData && fetchedAlbumData.id === result.id) return fetchedAlbumData;
    setFetchedAlbumData(null);
    const albumDataResponse = await axios.get('/api/apple/get-album', {
        params: { album_id: result.id },
        headers: country ? { 'Token-Country': country } : {}
    });
    setFetchedAlbumData(albumDataResponse.data.data);
    return albumDataResponse.data.data;
}
