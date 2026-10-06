import axios from 'axios';

// ---------------------------------------------------------------------------
// Server-only native TIDAL client: this deployment's own HiFi API.
//
// Answers the HiFi API's routes (/search/, /info/, /track/, /album/, ...)
// in-process, logged in to TIDAL with the deployment's own account, so
// trypt-hifi needs no external HiFi instance. It is used two ways:
//
//   - lib/tidal-server.tsx's tidalRequest() calls hifiApi() directly when the
//     account is configured (the web UI's TIDAL source);
//   - app/{search,info,track,...}/route.ts expose the same routes over HTTP,
//     so Tryptify can add this site as its TIDAL server.
//
// Ported from binimum/hifi-api (MIT, (c) 2023 sachin senal): the same TIDAL
// endpoints, query parameters and response envelopes, so both consumers parse
// it exactly like a real instance. Only one account is used, so there is no
// playback queue (no 202 + statusUrl answers).
//
// Credentials come only from the environment (the fields hifi-api's
// tidal_auth.py writes to token.json):
//   TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET, TIDAL_REFRESH_TOKEN
//   TIDAL_COUNTRY_CODE (optional; detected from the account when unset)
// Do NOT import this into the client.
// ---------------------------------------------------------------------------

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

// Tryptify compares versions as decimals ("2.10" reads as 2.1), and gates
// /artist/similar/, /recommendations/ and /artist/unreleased/ on >= 2.3-2.5.
export const HIFI_API_VERSION = '2.9';

const API_V1 = 'https://api.tidal.com/v1';
const OPENAPI_V2 = 'https://openapi.tidal.com/v2';
const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';

const HEADERS = {
    'User-Agent': 'okhttp/5.3.2',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Platform': 'android',
    'X-Tidal-Platform': 'android'
};

const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_RETRIES = 3;
// Albums whose tracks /artist/?f= (without skip_tracks) fetches at once.
const ALBUM_TRACKS_CONCURRENCY = 8;

// A HiFi API error: the HTTP status and FastAPI-style `detail` a real instance answers with.
export class HifiError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message);
    }
}

export const nativeTidalConfigured = (): boolean => Boolean(process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET && process.env.TIDAL_REFRESH_TOKEN);

function proxyAgent() {
    if (process.env.SOCKS5_PROXY) return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Session ---------------------------------------------------------------

let session: { accessToken: string; issuedAt: number; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
    if (!nativeTidalConfigured()) throw new HifiError(503, 'TIDAL is not configured: set TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET and TIDAL_REFRESH_TOKEN.');
    const clientId = process.env.TIDAL_CLIENT_ID!;
    const agent = proxyAgent();
    const response = await axios.post(
        TOKEN_URL,
        new URLSearchParams({ client_id: clientId, refresh_token: process.env.TIDAL_REFRESH_TOKEN!, grant_type: 'refresh_token' }).toString(),
        {
            auth: { username: clientId, password: process.env.TIDAL_CLIENT_SECRET! },
            headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
            httpAgent: agent,
            httpsAgent: agent,
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: () => true
        }
    );
    if (response.status !== 200 || !response.data?.access_token) {
        const reason = response.data?.error_description || response.data?.error || `HTTP ${response.status}`;
        console.error(`[tidal] token refresh failed: ${reason}`);
        throw new HifiError(401, `TIDAL login failed (${reason}). Check TIDAL_REFRESH_TOKEN, TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET.`);
    }
    // Renew a minute early so a token never expires mid-request.
    const now = Date.now();
    session = { accessToken: response.data.access_token, issuedAt: now, expiresAt: now + ((Number(response.data.expires_in) || 3600) - 60) * 1000 };
    return session.accessToken;
}

async function accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && session && Date.now() < session.expiresAt) return session.accessToken;
    // Concurrent requests share one in-flight refresh instead of each logging in.
    refreshing ??= refreshAccessToken().finally(() => {
        refreshing = null;
    });
    return refreshing;
}

// --- Requests --------------------------------------------------------------

type Params = Record<string, string | number | boolean | string[] | null | undefined>;

// Repeated keys (e.g. formats=FLAC&formats=EAC3_JOC) are sent as given, which axios' own serializer would turn into formats[]=.
function withParams(url: string, params: Params): string {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        for (const item of Array.isArray(value) ? value : [value]) target.searchParams.append(key, String(item));
    }
    return target.toString();
}

// A 404 can come from a stale token (hifi-api retries those after a refresh), but
// mostly means an unknown id, so only a token at least this old is refreshed for one.
const STALE_TOKEN_MS = 10 * 60 * 1000;

// Authenticated GET to TIDAL. Mirrors hifi-api: one forced token refresh on 401
// (or a 404 from an old token), and backoff on 429.
async function tidalGet(url: string, params: Params = {}): Promise<any> {
    const target = withParams(url, params);
    const agent = proxyAgent();
    let token = await accessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
        let response;
        try {
            response = await axios.get(target, {
                headers: { ...HEADERS, authorization: `Bearer ${token}` },
                httpAgent: agent,
                httpsAgent: agent,
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: () => true
            });
        } catch (error: any) {
            // hifi-api answers 429 on timeouts so clients back off and retry.
            if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') throw new HifiError(429, 'Upstream timeout');
            throw new HifiError(503, 'Connection error to Tidal');
        }

        const staleToken = response.status === 404 && session !== null && Date.now() - session.issuedAt > STALE_TOKEN_MS;
        if ((response.status === 401 || staleToken) && !refreshed) {
            refreshed = true;
            token = await accessToken(true);
            continue;
        }
        if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
            const retryAfter = Number(response.headers['retry-after']);
            const delay = Math.min(Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 2 ** attempt, 10);
            await sleep(delay * 1000);
            continue;
        }
        if (response.status >= 400) {
            const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            console.error(`[tidal] ${response.status} ${new URL(target).pathname}: ${String(body).slice(0, 500)}`);
            throw new HifiError(response.status, 'Upstream API error');
        }
        return response.data;
    }
}

// The account's own country; TIDAL region-locks by account, so it is the right default.
let countryCode: Promise<string> | null = null;
function country(): Promise<string> {
    if (process.env.TIDAL_COUNTRY_CODE) return Promise.resolve(process.env.TIDAL_COUNTRY_CODE);
    countryCode ??= tidalGet(`${API_V1}/sessions`)
        .then((s) => (typeof s?.countryCode === 'string' && s.countryCode) || 'US')
        .catch((error) => {
            // Don't cache a failure (e.g. a bad token): the next request tries again.
            countryCode = null;
            throw error;
        });
    return countryCode;
}

const wrap = (data: unknown) => ({ version: HIFI_API_VERSION, data });

// --- Query parsing ---------------------------------------------------------

// FastAPI-style parameter validation: a bad or missing parameter is a 422.
class Query {
    constructor(private params: URLSearchParams) {}

    str(name: string): string | undefined {
        return this.params.get(name) ?? undefined;
    }

    required(name: string): string {
        const value = this.str(name);
        if (!value) throw new HifiError(422, `Missing query parameter: ${name}`);
        return value;
    }

    int(name: string, fallback?: number, min = -Infinity, max = Infinity): number | undefined {
        const raw = this.str(name);
        if (raw === undefined || raw === '') return fallback;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < min || value > max) throw new HifiError(422, `Invalid query parameter: ${name}`);
        return value;
    }

    requiredInt(name: string): number {
        const value = this.int(name);
        if (value === undefined) throw new HifiError(422, `Missing query parameter: ${name}`);
        return value;
    }

    bool(name: string, fallback: boolean): boolean {
        const raw = this.str(name)?.toLowerCase();
        if (raw === undefined) return fallback;
        return ['true', '1', 'yes', 'on'].includes(raw);
    }

    all(name: string): string[] {
        return this.params.getAll(name);
    }
}

// --- Routes ----------------------------------------------------------------

const unwrapItems = (page: any): any[] => {
    const items = page && typeof page === 'object' && !Array.isArray(page) ? page.items : page;
    return Array.isArray(items) ? items : [];
};

// Runs fn over items, at most `limit` at a time, keeping each outcome.
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            try {
                results[index] = { status: 'fulfilled', value: await fn(items[index]) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// "https://resources.tidal.com/images/aaaa/bbbb/cccc/dddd/eeee/750x750.jpg" -> "aaaa-bbbb-cccc-dddd-eeee"
const uuidFromTidalURL = (href: string | undefined): string | null => {
    const parts = href ? href.split('/') : [];
    return parts.length >= 9 ? parts.slice(4, 9).join('-') : null;
};

const numericId = (id: unknown) => (/^\d+$/.test(String(id)) ? Number(id) : id);

async function info(q: Query) {
    return wrap(await tidalGet(`${API_V1}/tracks/${q.requiredInt('id')}/`, { countryCode: await country() }));
}

async function track(q: Query) {
    return wrap(
        await tidalGet(`${API_V1}/tracks/${q.requiredInt('id')}/playbackinfo`, {
            audioquality: q.str('quality') || 'HI_RES_LOSSLESS',
            playbackmode: 'STREAM',
            assetpresentation: 'FULL',
            immersiveaudio: q.bool('immersiveaudio', false)
        })
    );
}

async function trackManifests(q: Query) {
    const formats = q.all('formats');
    return wrap(
        await tidalGet(`${OPENAPI_V2}/trackManifests/${encodeURIComponent(q.required('id'))}`, {
            adaptive: q.str('adaptive') || 'true',
            manifestType: q.str('manifestType') || 'MPEG_DASH',
            uriScheme: q.str('uriScheme') || 'HTTPS',
            usage: q.str('usage') || 'PLAYBACK',
            formats: formats.length ? formats : ['HEAACV1', 'AACLC', 'FLAC', 'FLAC_HIRES', 'EAC3_JOC']
        })
    );
}

async function recommendations(q: Query) {
    return wrap(await tidalGet(`${API_V1}/tracks/${q.requiredInt('id')}/recommendations`, { limit: 20, countryCode: await country() }));
}

// One query key per search type, as on hifi-api: s = tracks, a = artists (+ tracks),
// al = albums, v = videos, p = playlists, i = ISRC lookup.
async function search(q: Query) {
    const offset = q.int('offset', 0, 0);
    const limit = q.int('limit', 25, 1, 500);
    const countryCode = await country();
    const isrc = q.str('i')?.trim();
    if (isrc) return wrap(await tidalGet(`${API_V1}/tracks`, { isrc, limit, offset, countryCode }));

    const s = q.str('s');
    if (s) return wrap(await tidalGet(`${API_V1}/search/tracks`, { query: s, limit, offset, countryCode }));

    const topHits: [string, string][] = [
        ['a', 'ARTISTS,TRACKS'],
        ['al', 'ALBUMS'],
        ['v', 'VIDEOS'],
        ['p', 'PLAYLISTS']
    ];
    for (const [key, types] of topHits) {
        const query = q.str(key);
        if (query) return wrap(await tidalGet(`${API_V1}/search/top-hits`, { query, limit, offset, types, countryCode }));
    }
    throw new HifiError(400, 'Provide one of s, a, al, v, p, or i');
}

// Album metadata with its tracklist (fetched in pages of 100) merged in as `items`.
async function album(q: Query) {
    const id = q.requiredInt('id');
    const limit = q.int('limit', 100, 1, 500)!;
    const offset = q.int('offset', 0, 0)!;
    const countryCode = await country();
    const pages: Promise<any>[] = [];
    for (let start = offset; start < offset + limit; start += 100) {
        pages.push(tidalGet(`${API_V1}/albums/${id}/items`, { countryCode, limit: Math.min(100, offset + limit - start), offset: start }));
    }
    const [data, ...itemPages] = await Promise.all([tidalGet(`${API_V1}/albums/${id}`, { countryCode }), ...pages]);
    return wrap({ ...data, items: itemPages.flatMap(unwrapItems) });
}

async function playlist(q: Query) {
    const id = q.required('id');
    const countryCode = await country();
    const [playlistData, itemsData] = await Promise.all([
        tidalGet(`${API_V1}/playlists/${encodeURIComponent(id)}`, { countryCode }),
        tidalGet(`${API_V1}/playlists/${encodeURIComponent(id)}/items`, {
            countryCode,
            limit: q.int('limit', 100, 1, 500),
            offset: q.int('offset', 0, 0)
        })
    ]);
    return { version: HIFI_API_VERSION, playlist: playlistData, items: unwrapItems(itemsData) };
}

// id: artist metadata (+ a 750px picture). f: the discography (albums, then
// EPs and singles), plus top tracks with skip_tracks, or every album's tracks without.
async function artist(q: Query) {
    const id = q.int('id');
    const f = q.int('f');
    if (id === undefined && f === undefined) throw new HifiError(400, 'Provide id or f query param');
    const countryCode = await country();

    if (id !== undefined) {
        const data = await tidalGet(`${API_V1}/artists/${id}`, { countryCode });
        if (!data.picture && data.selectedAlbumCoverFallback) data.picture = data.selectedAlbumCoverFallback;
        const cover = data.picture
            ? { id: data.id, name: data.name, '750': `https://resources.tidal.com/images/${String(data.picture).replace(/-/g, '/')}/750x750.jpg` }
            : null;
        return { version: HIFI_API_VERSION, artist: data, cover };
    }

    const skipTracks = q.bool('skip_tracks', false);
    const albumsURL = `${API_V1}/artists/${f}/albums`;
    const [albums, singles, top] = await Promise.allSettled([
        tidalGet(albumsURL, { countryCode, limit: 100 }),
        tidalGet(albumsURL, { countryCode, limit: 100, filter: 'EPSANDSINGLES' }),
        skipTracks ? tidalGet(`${API_V1}/artists/${f}/toptracks`, { countryCode, limit: 15 }) : Promise.resolve(null)
    ]);

    const releases: any[] = [];
    const seen = new Set<unknown>();
    for (const result of [albums, singles]) {
        if (result.status === 'rejected') {
            console.warn('[tidal] artist releases:', (result.reason as Error)?.message);
            continue;
        }
        for (const item of unwrapItems(result.value)) {
            if (item?.id && !seen.has(item.id)) {
                seen.add(item.id);
                releases.push(item);
            }
        }
    }
    const page = { items: releases };

    if (skipTracks) return { version: HIFI_API_VERSION, albums: page, tracks: top.status === 'fulfilled' ? unwrapItems(top.value) : [] };

    const albumTracks = await mapLimited(releases, ALBUM_TRACKS_CONCURRENCY, async (release) => {
        const data = await tidalGet(`${API_V1}/pages/album`, { albumId: release.id, countryCode, deviceType: 'BROWSER' });
        const items = data?.rows?.[1]?.modules?.[0]?.pagedList?.items ?? [];
        return (items as any[]).map((entry) => entry?.item ?? entry);
    });
    const tracks = albumTracks.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    return { version: HIFI_API_VERSION, albums: page, tracks };
}

// Similar artists from the v2 (JSON:API) catalog, flattened like hifi-api's.
async function similarArtists(q: Query) {
    const payload = await tidalGet(`${OPENAPI_V2}/artists/${q.requiredInt('id')}/relationships/similarArtists`, {
        'page[cursor]': q.str('cursor'),
        countryCode: await country(),
        include: 'similarArtists,similarArtists.profileArt'
    });
    const included: any[] = payload?.included ?? [];
    const byId = (type: string) => new Map(included.filter((i) => i.type === type).map((i) => [i.id, i]));
    const artists = byId('artists');
    const artworks = byId('artworks');

    return {
        version: HIFI_API_VERSION,
        artists: ((payload?.data ?? []) as any[]).map((entry) => {
            const resource = artists.get(entry.id) ?? {};
            const attributes = resource.attributes ?? {};
            const artwork = artworks.get(resource.relationships?.profileArt?.data?.[0]?.id);
            const picture = uuidFromTidalURL(artwork?.attributes?.files?.[0]?.href);
            return {
                ...attributes,
                id: numericId(entry.id),
                picture: picture || attributes.selectedAlbumCoverFallback,
                url: `http://www.tidal.com/artist/${entry.id}`,
                relationType: 'SIMILAR_ARTIST'
            };
        })
    };
}

async function lyrics(q: Query) {
    const data = await tidalGet(`${API_V1}/tracks/${q.requiredInt('id')}/lyrics`, { countryCode: await country(), locale: 'en_US', deviceType: 'BROWSER' });
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) throw new HifiError(404, 'Lyrics not found');
    return { version: HIFI_API_VERSION, lyrics: data };
}

const ROUTES: Record<string, (q: Query) => Promise<unknown>> = {
    '/info/': info,
    '/track/': track,
    '/trackManifests/': trackManifests,
    '/recommendations/': recommendations,
    '/search/': search,
    '/album/': album,
    '/playlist/': playlist,
    '/artist/': artist,
    '/artist/similar/': similarArtists,
    '/lyrics/': lyrics
};

export const HIFI_API_PATHS = Object.keys(ROUTES);

// Answers one HiFi API request (path as on hifi-api, trailing slash included) with
// the JSON body a real instance would send. Failures throw HifiError.
export async function hifiApi(path: string, params: URLSearchParams): Promise<unknown> {
    const handler = ROUTES[path];
    if (!handler) throw new HifiError(404, 'Not Found');
    return handler(new Query(params));
}
