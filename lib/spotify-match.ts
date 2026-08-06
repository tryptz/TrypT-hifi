import { APIOptionProps, getQobuzTrackUrl, QobuzSearchResults, QobuzTrack } from './qobuz-dl';
import { MatchConfidence, SpotifyMatch, SpotifyTrack } from './spotify';
import { search } from './qobuz-dl-server';

// Translates a Spotify track into its Qobuz equivalent.
// Functions only to be used by servers
// Do not import this file into the client

// A candidate has to clear this to count as a match at all; anything below is
// reported as "no Qobuz match" rather than silently handing back the wrong song.
const ACCEPT_SCORE = 0.6;
const MEDIUM_SCORE = 0.72;
const HIGH_SCORE = 0.85;

// Edition/version noise that Spotify and Qobuz spell differently for the same
// recording, plus the "feat. ..." credits Qobuz keeps out of the track title.
const FEATURING_REGEX = /\s*[([]?\s*(feat|ft|featuring|with)\.?\s[^)\]]*[)\]]?/gi;
const EDITION_NOISE_REGEX =
    /\b(\d{4}\s+)?(digital\s+)?(remaster(ed)?(\s+version)?|remaster(ed)?\s+\d{4}|album\s+version|single\s+version|original\s+mix|bonus\s+track|deluxe(\s+edition)?|expanded(\s+edition)?|anniversary(\s+edition)?|explicit(\s+version)?|clean(\s+version)?)\b/gi;

// Markers for a genuinely different recording of the same song. Unlike the
// edition noise above these must agree on both sides — a live take is not a
// substitute for the studio version.
const RENDITION_REGEX = /\b(live|acoustic|instrumental|karaoke|demo|unplugged|remix|cover|reprise|session|a cappella|acapella)\b/g;

export function normalizeText(input: string): string {
    return input
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(FEATURING_REGEX, ' ')
        .replace(EDITION_NOISE_REGEX, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function bigrams(value: string): string[] {
    const pairs: string[] = [];
    for (let index = 0; index < value.length - 1; index++) pairs.push(value.slice(index, index + 2));
    return pairs;
}

// Sørensen–Dice over character bigrams: tolerant of spelling and punctuation
// drift between the two catalogues without needing an edit-distance matrix.
export function similarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

    const aPairs = bigrams(a);
    const bPairs = bigrams(b);
    const bCounts = new Map<string, number>();
    for (const pair of bPairs) bCounts.set(pair, (bCounts.get(pair) ?? 0) + 1);

    let hits = 0;
    for (const pair of aPairs) {
        const count = bCounts.get(pair) ?? 0;
        if (count > 0) {
            bCounts.set(pair, count - 1);
            hits++;
        }
    }
    return (2 * hits) / (aPairs.length + bPairs.length);
}

function candidateArtists(candidate: QobuzTrack): string[] {
    const names = [candidate.performer?.name, candidate.composer?.name, candidate.album?.artist?.name, ...(candidate.album?.artists ?? []).map((a) => a.name)];
    return names.filter((name): name is string => !!name);
}

function renditionMarkers(value: string): string {
    const markers = normalizeText(value).match(RENDITION_REGEX) ?? [];
    return Array.from(new Set(markers)).sort().join(' ');
}

function durationScore(spotifyDuration: number, candidateDuration: number): number {
    if (!spotifyDuration || !candidateDuration) return 0.5;
    const difference = Math.abs(spotifyDuration - candidateDuration);
    if (difference <= 2) return 1;
    if (difference <= 5) return 0.8;
    if (difference <= 10) return 0.4;
    if (difference <= 20) return 0.1;
    return 0;
}

export function scoreCandidate(spotify: SpotifyTrack, candidate: QobuzTrack): number {
    const spotifyTitle = normalizeText(spotify.title);
    // Qobuz splits editions off into `version`, so compare against both the bare
    // title and the title+version form and keep whichever lines up better.
    const titleScore = Math.max(
        similarity(spotifyTitle, normalizeText(candidate.title ?? '')),
        similarity(spotifyTitle, normalizeText(`${candidate.title ?? ''} ${candidate.version ?? ''}`))
    );

    const candidateNames = candidateArtists(candidate).map(normalizeText);
    let artistScore = 0;
    for (const artist of spotify.artists.map(normalizeText)) {
        for (const name of candidateNames) {
            // Qobuz frequently credits "Artist A, Artist B" as one performer string.
            const contained = artist.length > 2 && (name.includes(artist) || artist.includes(name));
            artistScore = Math.max(artistScore, contained ? 1 : similarity(artist, name));
        }
    }

    let score = 0.5 * titleScore + 0.3 * artistScore + 0.2 * durationScore(spotify.duration, candidate.duration);
    // A live/remix/acoustic take is a different recording — rank it below a
    // straight match, and flag it as a weaker match if it is all there is.
    if (renditionMarkers(spotify.title) !== renditionMarkers(`${candidate.title ?? ''} ${candidate.version ?? ''}`)) score -= 0.2;
    // Prefer a version that can actually be downloaded.
    if (!candidate.streamable) score -= 0.08;
    if (spotify.explicit !== !!candidate.parental_warning) score -= 0.02;
    return Math.max(0, Math.min(1, score));
}

function buildMatch(track: QobuzTrack, score: number, confidence: MatchConfidence): SpotifyMatch {
    return { matched: true, confidence, score: Number(score.toFixed(3)), url: getQobuzTrackUrl(track.id), track };
}

function searchedTracks(results: QobuzSearchResults | null): QobuzTrack[] {
    return results?.tracks?.items?.filter(Boolean) ?? [];
}

export async function matchSpotifyTrack(spotify: SpotifyTrack, options?: APIOptionProps): Promise<SpotifyMatch> {
    // A failing Qobuz search must not read as "this track isn't on Qobuz", so
    // hold onto the error and rethrow it if no search ever came back.
    let searchError: unknown = null;
    const runSearch = async (query: string, limit: number) => {
        try {
            return await search(query, limit, 0, options);
        } catch (error) {
            searchError = error;
            return null;
        }
    };

    // The ISRC identifies the exact recording, so a hit needs no scoring.
    if (spotify.isrc) {
        const results = await runSearch(spotify.isrc, 5);
        const isrcMatches = searchedTracks(results).filter((track) => track.isrc && track.isrc.toUpperCase() === spotify.isrc!.toUpperCase());
        const exact = isrcMatches.find((track) => track.streamable) ?? isrcMatches[0];
        if (exact) return buildMatch(exact, 1, 'isrc');
    }

    // Otherwise fall back to text search, scored against the Spotify metadata.
    const queries = [`${spotify.artists[0] ?? ''} ${spotify.title}`.trim(), spotify.title.trim()].filter(
        (query, index, all) => query.length > 0 && all.indexOf(query) === index
    );

    let best: QobuzTrack | null = null;
    let bestScore = 0;
    let searched = false;
    for (const query of queries) {
        const results = await runSearch(query, 10);
        if (results) searched = true;
        for (const candidate of searchedTracks(results)) {
            const score = scoreCandidate(spotify, candidate);
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
            }
        }
        // Confident enough already — don't spend another Qobuz search on it.
        if (bestScore >= HIGH_SCORE) break;
    }

    if (!best && !searched && searchError) throw searchError;
    if (!best || bestScore < ACCEPT_SCORE) return { matched: false, confidence: null, score: Number(bestScore.toFixed(3)), url: null, track: null };
    return buildMatch(best, bestScore, bestScore >= HIGH_SCORE ? 'high' : bestScore >= MEDIUM_SCORE ? 'medium' : 'low');
}
