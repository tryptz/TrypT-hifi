import { QobuzTrack } from './qobuz-dl';

// Shared Spotify importer types and link helpers.
// Safe to import from both the client and the server.

export type SpotifyTrack = {
    id: string;
    title: string;
    artists: string[];
    album: string;
    isrc: string | null;
    duration: number;
    explicit: boolean;
    url: string | null;
};

export type SpotifyPlaylist = {
    id: string;
    name: string;
    description: string;
    owner: string;
    image: string | null;
    url: string;
    // `total` is what Spotify reports for the playlist, which can be larger than
    // `tracks.length` when the import cap kicks in or entries are skipped.
    total: number;
    truncated: boolean;
    tracks: SpotifyTrack[];
};

// How the Qobuz equivalent was found. An ISRC hit is an identifier match, the
// rest come from scoring text search candidates.
export type MatchConfidence = 'isrc' | 'high' | 'medium' | 'low';

export type SpotifyMatch = {
    matched: boolean;
    confidence: MatchConfidence | null;
    score: number;
    url: string | null;
    track: QobuzTrack | null;
};

export const SPOTIFY_PLAYLIST_URL_REGEX =
    /(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?playlist\/([a-zA-Z0-9]+)|spotify:playlist:([a-zA-Z0-9]+)/;

// Accepts https://open.spotify.com/playlist/<id> (with optional /intl-xx/ locale
// segment and query string) as well as the spotify:playlist:<id> URI form.
export function parseSpotifyPlaylistId(input: string): string | null {
    const match = input.trim().match(SPOTIFY_PLAYLIST_URL_REGEX);
    if (!match) return null;
    return match[1] || match[2] || null;
}

export function formatSpotifyArtists(track: SpotifyTrack, separator: string = ', ') {
    return track.artists.length > 0 ? track.artists.join(separator) : 'Unknown Artist';
}

export const matchConfidenceLabels: Record<MatchConfidence, string> = {
    isrc: 'ISRC',
    high: 'High',
    medium: 'Medium',
    low: 'Low'
};
