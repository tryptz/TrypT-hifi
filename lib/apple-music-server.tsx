import { getStorefrontForCountry } from '@/config/apple-storefronts';
import { signFileURL } from './file-proxy';
import { isWrapperConfigured, resolveDeviceM3u8 } from './apple-wrapper-client';
import {
    AppleAlbum,
    AppleArtist,
    AppleQuality,
    AppleSearchResponse,
    AppleSong,
    AppleStreamVariant,
    DownloadJobManifest,
    matchAppleUrl,
    normalizeAppleAlbum,
    normalizeAppleAlbumFull,
    normalizeAppleArtist,
    normalizeAppleSearch,
    normalizeAppleSong,
    parseAppleArtistData,
    templateArtwork
} from './apple-music';
import { APIOptionProps, FetchedQobuzAlbum, QobuzArtistResults, QobuzSearchResults } from './qobuz-dl';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Server-only Apple Music API client.
//
// Counterpart to lib/qobuz-dl-server.tsx. Do NOT import this into the client.
//
//   - Mints + caches an ES256 developer JWT (Node built-in crypto, no extra dep).
//   - Talks to api.music.apple.com with the same CORS_PROXY / SOCKS5_PROXY
//     passthrough the Qobuz client uses.
//   - Normalizes catalog responses into the shared Qobuz* shapes.
//   - Builds the download-job manifest (the handoff to Tryptify). It never
//     acquires a FairPlay license, never decrypts, never touches the Atmos
//     bitstream (transcoding would strip the EC-3 JOC side-data).
// ---------------------------------------------------------------------------

let crypto: any;
let fs: any;
let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    crypto = require('node:crypto');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const APPLE_API_BASE = () => process.env.APPLE_API_BASE || 'https://api.music.apple.com';
const LICENSE_SERVER_URL = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense';
const SIX_MONTHS_SECONDS = 15777000; // Apple's hard cap on developer-token lifetime

export type AppleOptionProps = APIOptionProps & { userToken?: string };

export function testForRequirements() {
    if (process.env.APPLE_DEVELOPER_TOKEN && process.env.APPLE_DEVELOPER_TOKEN.length > 0) return true;
    // No hard requirement anymore: getDeveloperToken() falls back to the public
    // Apple Music web-player token when no APPLE_DEVELOPER_TOKEN / .p8 signing
    // material is configured, so catalog access works with only a Music-User-Token.
    return true;
}

function base64urlJson(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function readPrivateKeyPem(): string {
    if (process.env.APPLE_PRIVATE_KEY) return process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    if (process.env.APPLE_PRIVATE_KEY_PATH) return fs.readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, 'utf8');
    throw new Error('No Apple MusicKit private key configured.');
}

let cachedToken: { jwt: string; exp: number } | null = null;
let cachedWebToken: { jwt: string; exp: number } | null = null;

const WEB_PLAYER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Fallback developer token: the Apple Music web player ships a public MusicKit
// JWT (iss "AMPWebPlay") embedded in its JS bundle. Scraping it lets catalog
// access work with only a Music-User-Token — no Apple Developer Program
// membership / .p8 required. The token rotates (~monthly), so cache by its own
// exp and re-scrape as it nears expiry. The bundle hash changes too, so the
// current bundle is discovered from the browse page each time we refresh.
async function fetchWebPlayerToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (cachedWebToken && cachedWebToken.exp - now > 86400) return cachedWebToken.jwt;

    const agent = proxyAgent();
    const get = async (url: string): Promise<string> => {
        const target = process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url) : url;
        const res = await axios.get(target, { headers: { 'User-Agent': WEB_PLAYER_UA }, responseType: 'text', httpAgent: agent, httpsAgent: agent });
        return res.data as string;
    };

    const home = await get('https://music.apple.com/us/browse');
    const bundle = (home.match(/\/assets\/index[-~][\w.]*\.js/) || [])[0];
    if (!bundle) throw new Error('Apple web-player token: could not locate the app bundle on music.apple.com');
    const js = await get('https://music.apple.com' + bundle);

    const candidates = js.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g) || [];
    for (const jwt of candidates) {
        try {
            const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
            if (payload.iss === 'AMPWebPlay' && payload.exp && payload.exp > now) {
                cachedWebToken = { jwt, exp: payload.exp };
                return jwt;
            }
        } catch {
            // not a JWT we can read; keep scanning
        }
    }
    throw new Error('Apple web-player token: no live AMPWebPlay token found in the app bundle');
}

// Return a MusicKit developer token from, in order: APPLE_DEVELOPER_TOKEN, a JWT
// minted from .p8 signing material, or the scraped web-player token. Node's
// crypto.sign with dsaEncoding 'ieee-p1363' emits the JOSE (r||s) signature
// format directly, so no external JWT library is needed for the minting path.
export async function getDeveloperToken(): Promise<string> {
    if (process.env.APPLE_DEVELOPER_TOKEN && process.env.APPLE_DEVELOPER_TOKEN.length > 0) return process.env.APPLE_DEVELOPER_TOKEN;

    // Without self-signing material, fall back to the public web-player token.
    if (!process.env.APPLE_TEAM_ID || !process.env.APPLE_KEY_ID || (!process.env.APPLE_PRIVATE_KEY && !process.env.APPLE_PRIVATE_KEY_PATH)) {
        return fetchWebPlayerToken();
    }

    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.exp - now > 86400) return cachedToken.jwt;

    const ttlDays = Number(process.env.APPLE_DEV_TOKEN_TTL_DAYS) || 150;
    const ttl = Math.min(ttlDays * 24 * 60 * 60, SIX_MONTHS_SECONDS - 60);
    const exp = now + ttl;

    const header = { alg: 'ES256', kid: process.env.APPLE_KEY_ID!, typ: 'JWT' };
    const payload = { iss: process.env.APPLE_TEAM_ID!, iat: now, exp };
    const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;

    const keyObject = crypto.createPrivateKey(readPrivateKeyPem());
    const signature: Buffer = crypto.sign('sha256', Buffer.from(signingInput), { key: keyObject, dsaEncoding: 'ieee-p1363' });
    const jwt = `${signingInput}.${signature.toString('base64url')}`;

    cachedToken = { jwt, exp };
    return jwt;
}

export async function getAppleHeaders(userToken?: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await getDeveloperToken()}` };
    const resolvedUserToken = userToken || process.env.APPLE_MUSIC_USER_TOKEN;
    if (resolvedUserToken) headers['Music-User-Token'] = resolvedUserToken;
    // Apple validates Origin for web-player (AMPWebPlay) tokens; harmless otherwise.
    headers['Origin'] = 'https://music.apple.com';
    if (process.env.CORS_PROXY) headers['User-Agent'] = 'Tryptify';
    return headers;
}

function proxyAgent() {
    if (process.env.SOCKS5_PROXY) return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    return undefined;
}

// Core request helper. Mirrors the Qobuz axios pattern (CORS_PROXY prefix +
// encodeURIComponent, SOCKS5 agent) and adds a small 429 backoff.
export async function appleRequest<T = any>(
    path: string,
    options: AppleOptionProps & { params?: Record<string, string | number | undefined> } = {}
): Promise<T> {
    testForRequirements();
    const { userToken, country, params, ...requestOptions } = options;
    void country; // storefront is already baked into `path` by callers
    const url = new URL(APPLE_API_BASE().replace(/\/$/, '') + path);
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
        }
    }
    const headers = await getAppleHeaders(userToken);
    const agent = proxyAgent();
    const target = process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString();

    let attempt = 0;
    for (;;) {
        try {
            const response = await axios.get(target, { headers, httpAgent: agent, httpsAgent: agent, ...requestOptions });
            return response.data as T;
        } catch (error: any) {
            const status = error?.response?.status;
            if (status === 429 && attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
                attempt++;
                continue;
            }
            throw error;
        }
    }
}

// --- Low-level catalog fetches ---------------------------------------------

async function fetchSong(adamId: string, storefront: string, options: AppleOptionProps, extend = false): Promise<AppleSong> {
    const data = await appleRequest<{ data: AppleSong[] }>(`/v1/catalog/${storefront}/songs/${adamId}`, {
        ...options,
        params: { include: 'albums,artists', ...(extend ? { extend: 'extendedAssetUrls' } : {}) }
    });
    if (!data?.data?.[0]) throw new Error(`Apple song ${adamId} not found`);
    return data.data[0];
}

async function fetchAlbum(albumId: string, storefront: string, options: AppleOptionProps): Promise<AppleAlbum> {
    const data = await appleRequest<{ data: AppleAlbum[] }>(`/v1/catalog/${storefront}/albums/${albumId}`, {
        ...options,
        params: { include: 'tracks,artists' }
    });
    if (!data?.data?.[0]) throw new Error(`Apple album ${albumId} not found`);
    return data.data[0];
}

async function fetchArtist(artistId: string, storefront: string, options: AppleOptionProps): Promise<AppleArtist> {
    const data = await appleRequest<{ data: AppleArtist[] }>(`/v1/catalog/${storefront}/artists/${artistId}`, {
        ...options,
        params: { views: 'full-albums,top-songs' }
    });
    if (!data?.data?.[0]) throw new Error(`Apple artist ${artistId} not found`);
    return data.data[0];
}

// --- Public API (mirrors qobuz-dl-server signatures) -----------------------

export async function search(query: string, limit: number = 10, offset: number = 0, options?: AppleOptionProps): Promise<QobuzSearchResults> {
    testForRequirements();
    const opts = options || {};
    const storefront = getStorefrontForCountry(opts.country);

    // Pasted music.apple.com URLs resolve to a single targeted result.
    const urlMatch = matchAppleUrl(query);
    const emptyBucket = { limit, offset, total: 0, items: [] as any[] };
    if (urlMatch) {
        if (urlMatch.kind === 'albums') {
            const album = normalizeAppleAlbum(await fetchAlbum(urlMatch.id, storefront, opts), storefront);
            return { query, switchTo: 'albums', albums: { limit, offset, total: 1, items: [album] }, tracks: { ...emptyBucket }, artists: { ...emptyBucket } };
        }
        if (urlMatch.kind === 'artists') {
            const artist = normalizeAppleArtist(await fetchArtist(urlMatch.id, storefront, opts));
            return { query, switchTo: 'artists', albums: { ...emptyBucket }, tracks: { ...emptyBucket }, artists: { limit, offset, total: 1, items: [artist] } };
        }
        // tracks
        const track = normalizeAppleSong(await fetchSong(urlMatch.id, storefront, opts), undefined, storefront);
        return { query, switchTo: 'tracks', albums: { ...emptyBucket }, tracks: { limit, offset, total: 1, items: [track] }, artists: { ...emptyBucket } };
    }

    const data = await appleRequest<AppleSearchResponse>(`/v1/catalog/${storefront}/search`, {
        ...opts,
        params: { term: query, types: 'songs,albums,artists', limit, offset }
    });
    return normalizeAppleSearch(data, query, limit, offset, null, storefront);
}

export async function getAlbumInfo(album_id: string, options?: AppleOptionProps): Promise<FetchedQobuzAlbum> {
    const opts = options || {};
    const storefront = getStorefrontForCountry(opts.country);
    return normalizeAppleAlbumFull(await fetchAlbum(album_id, storefront, opts), storefront);
}

// Returns the already-parsed inner `artist` object (QobuzArtistResults['artist']),
// so the route can wrap it as { data: { artist } } exactly like the Qobuz route.
export async function getArtist(artist_id: string, options?: AppleOptionProps): Promise<QobuzArtistResults['artist']> {
    const opts = options || {};
    const storefront = getStorefrontForCountry(opts.country);
    return parseAppleArtistData(await fetchArtist(artist_id, storefront, opts), storefront).artist;
}

export async function getArtistReleases(
    artist_id: string,
    release_type: string = 'album',
    limit: number = 10,
    offset: number = 0,
    track_size: number = 1000,
    options?: AppleOptionProps
) {
    void release_type; // Apple has no album/live/compilation split at this endpoint
    void track_size;
    const opts = options || {};
    const storefront = getStorefrontForCountry(opts.country);
    const data = await appleRequest<{ data: AppleAlbum[]; next?: string }>(`/v1/catalog/${storefront}/artists/${artist_id}/albums`, {
        ...opts,
        params: { limit, offset }
    });
    return {
        items: (data.data || []).map((album) => normalizeAppleAlbum(album, storefront)),
        has_more: Boolean(data.next)
    };
}

// --- HLS master-playlist parsing -------------------------------------------

function parseAttributes(line: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    // key=value pairs, value optionally quoted, commas inside quotes ignored
    const regex = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
        attrs[match[1]] = match[3] !== undefined ? match[3] : match[2];
    }
    return attrs;
}

function codecFromGroupId(groupId: string): string {
    const id = groupId.toLowerCase();
    if (id.startsWith('audio-alac')) return 'alac';
    if (id.includes('atmos')) return 'ec-3';
    if (id.includes('ec3') || id.includes('ec-3')) return 'ec-3';
    if (id.includes('ac3') || id.includes('ac-3')) return 'ac-3';
    if (id.includes('aac') || id.includes('audio-stereo')) return 'mp4a.40.2';
    return 'unknown';
}

function detailsFromGroupId(groupId: string): { sampleRate: number | null; bitDepth: number | null } {
    // e.g. audio-alac-stereo-44100-16  ->  44100 / 16
    const m = groupId.match(/-(\d{4,6})-(\d{1,2})$/);
    if (m) return { sampleRate: Number(m[1]), bitDepth: Number(m[2]) };
    return { sampleRate: null, bitDepth: null };
}

export function parseHlsMaster(text: string, masterUrl: string): AppleStreamVariant[] {
    const lines = text.split(/\r?\n/);
    const mediaByGroup = new Map<string, { channels: number | null; uri: string | null }>();
    const streamCodecs = new Map<string, { codecs: string | null; bandwidth: number | null }>();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(line)) {
            const attrs = parseAttributes(line);
            const groupId = attrs['GROUP-ID'];
            if (!groupId) continue;
            // Apple's Atmos rendition uses CHANNELS="16/JOC"; take the leading
            // integer (the object count) rather than letting Number() -> NaN.
            const channelsRaw = attrs['CHANNELS'];
            const channelsParsed = channelsRaw ? parseInt(channelsRaw, 10) : NaN;
            mediaByGroup.set(groupId, {
                channels: Number.isFinite(channelsParsed) ? channelsParsed : null,
                uri: attrs['URI'] || null
            });
        } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const attrs = parseAttributes(line);
            const group = attrs['AUDIO'];
            if (!group) continue;
            streamCodecs.set(group, {
                codecs: attrs['CODECS'] || null,
                bandwidth: attrs['BANDWIDTH'] ? Number(attrs['BANDWIDTH']) : null
            });
        }
    }

    const variants: AppleStreamVariant[] = [];
    mediaByGroup.forEach((media, groupId) => {
        const stream = streamCodecs.get(groupId);
        const details = detailsFromGroupId(groupId);
        variants.push({
            codecId: groupId,
            codec: codecFromGroupId(groupId),
            channels: media.channels,
            sampleRate: details.sampleRate,
            bitDepth: details.bitDepth,
            bandwidth: stream?.bandwidth ?? null,
            mediaPlaylistUrl: media.uri ? new URL(media.uri, masterUrl).toString() : null,
            keyUri: null // only present in the media playlist (EXT-X-KEY), resolved on-device
        });
    });
    return variants;
}

function pickVariant(variants: AppleStreamVariant[], quality: AppleQuality): AppleStreamVariant | null {
    const matches = variants.filter((v) => {
        const id = v.codecId.toLowerCase();
        if (quality === 'atmos') return id.includes('atmos') || v.codec === 'ec-3';
        if (quality === 'alac' || quality === 'hires-lossless') return id.startsWith('audio-alac');
        return id.includes('aac') || id.includes('audio-stereo') || v.codec.startsWith('mp4a');
    });
    if (matches.length === 0) return null;
    // Prefer the highest fidelity (sampleRate, then bitDepth, then bandwidth).
    matches.sort((a, b) => (b.sampleRate ?? 0) - (a.sampleRate ?? 0) || (b.bitDepth ?? 0) - (a.bitDepth ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    return matches[0];
}

async function fetchText(url: string, options: AppleOptionProps): Promise<string> {
    const { userToken, country, ...requestOptions } = options;
    void country;
    const headers = await getAppleHeaders(userToken);
    const agent = proxyAgent();
    const target = process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url) : url;
    const response = await axios.get(target, { headers, responseType: 'text', httpAgent: agent, httpsAgent: agent, ...requestOptions });
    return response.data as string;
}

async function fetchLyricsTtml(adamId: string, storefront: string, options: AppleOptionProps): Promise<string | null> {
    // Requires a Music-User-Token + active subscription; best-effort only.
    if (!(options.userToken || process.env.APPLE_MUSIC_USER_TOKEN)) return null;
    try {
        const data = await appleRequest<{ data: { attributes?: { ttml?: string } }[] }>(`/v1/catalog/${storefront}/songs/${adamId}/lyrics`, options);
        return data?.data?.[0]?.attributes?.ttml ?? null;
    } catch {
        return null;
    }
}

function signManifest(manifest: Omit<DownloadJobManifest, 'sig'>): string | undefined {
    const secret = process.env.FILE_PROXY_SECRET || process.env.QOBUZ_SECRET;
    if (!secret) return undefined;
    return crypto.createHmac('sha256', secret).update(JSON.stringify(manifest)).digest('hex');
}

// Build the download-job manifest handed to Tryptify. Fills every field the
// developer token can resolve; flags license/decrypt/atmos as wrapper-only.
export async function buildDownloadManifest(
    adamId: string,
    quality: AppleQuality,
    options: AppleOptionProps & { origin?: string } = {}
): Promise<DownloadJobManifest> {
    testForRequirements();
    const { origin, ...opts } = options;
    const storefront = getStorefrontForCountry(opts.country);
    const song = await fetchSong(adamId, storefront, opts, true);
    const a = song.attributes;
    const traits = a.audioTraits || [];

    // Attempt to resolve + parse the HLS master web-side. Hi-res/Atmos masters
    // are usually device-gated, so this frequently falls through to the wrapper.
    const enhancedHls = a.extendedAssetUrls?.enhancedHls || null;
    let masterUrl: string | null = enhancedHls;
    let variantTable: AppleStreamVariant[] = [];
    let chosenVariant: AppleStreamVariant | null = null;
    let deviceOnly = true;
    let m3u8Source: 'web-extendedAssetUrls' | 'wrapper-device' | null = null;
    if (enhancedHls) {
        m3u8Source = 'web-extendedAssetUrls';
        try {
            variantTable = parseHlsMaster(await fetchText(enhancedHls, opts), enhancedHls);
            chosenVariant = pickVariant(variantTable, quality);
            deviceOnly = variantTable.length === 0;
        } catch {
            deviceOnly = true;
        }
    }

    // If the developer-token web path could not reach a usable master (Apple
    // gates the hi-res/Atmos master behind a real device), fall back to a locally
    // running decryption wrapper, which resolves the device m3u8 for this adamId.
    // This is the sole point where the catalog layer talks to the wrapper; all
    // decrypt/render still happen on-device. No-ops unless APPLE_WRAPPER_HOST is set.
    if ((deviceOnly || !masterUrl) && isWrapperConfigured()) {
        try {
            const deviceMaster = await resolveDeviceM3u8(adamId);
            if (deviceMaster) {
                const parsed = parseHlsMaster(await fetchText(deviceMaster, opts), deviceMaster);
                if (parsed.length > 0) {
                    masterUrl = deviceMaster;
                    m3u8Source = 'wrapper-device';
                    variantTable = parsed;
                    chosenVariant = pickVariant(parsed, quality);
                    deviceOnly = false;
                }
            }
        } catch (error) {
            // Wrapper unreachable/misconfigured: keep the web-side result and leave
            // deviceOnly=true so Tryptify knows it must still resolve on-device.
            console.warn(`[apple-wrapper] device m3u8 resolution failed for ${adamId}:`, error instanceof Error ? error.message : error);
        }
    }

    const rawPreview = a.previews?.[0]?.url ?? null;
    const previewUrl = rawPreview && origin ? signFileURL(rawPreview, origin) : rawPreview;
    const ttml = await fetchLyricsTtml(adamId, storefront, opts);
    const albumAdamId = song.relationships?.albums?.data?.[0]?.id ?? null;

    const manifest: Omit<DownloadJobManifest, 'sig'> = {
        version: 1,
        source: 'apple-music',
        storefront,
        quality,
        track: {
            adamId,
            isrc: a.isrc ?? null,
            title: a.name,
            artist: a.artistName,
            album: a.albumName,
            albumAdamId,
            trackNumber: a.trackNumber ?? null,
            discNumber: a.discNumber ?? null,
            durationMs: a.durationInMillis ?? 0,
            contentRating: a.contentRating ?? null,
            copyright: null,
            releaseDate: a.releaseDate ?? null,
            genreNames: a.genreNames || []
        },
        artwork: {
            urlTemplate: a.artwork?.url ?? null,
            maxWidth: a.artwork?.width ?? null,
            maxHeight: a.artwork?.height ?? null,
            resolved: a.artwork?.url ? templateArtwork(a.artwork.url, Math.min(a.artwork.width || 3000, 3000)) : null
        },
        audioTraits: traits,
        m3u8: { masterUrl, source: m3u8Source, deviceOnly },
        chosenVariant,
        variantTable,
        license: { licenseServerUrl: LICENSE_SERVER_URL, keySystem: 'com.apple.fps', requiresWrapper: true },
        lyrics: { available: Boolean(a.hasLyrics), ttml },
        previewUrl,
        requiresWrapper: {
            m3u8: deviceOnly,
            license: true,
            decrypt: true,
            atmosRender: quality === 'atmos'
        },
        createdAt: Math.floor(Date.now() / 1000)
    };

    return { ...manifest, sig: signManifest(manifest) };
}
