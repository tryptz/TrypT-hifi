import axios, { AxiosRequestConfig } from 'axios';

// Functions only to be used by servers
// Do not import this into the client

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

// ---------------------------------------------------------------------------
// Full-length Deezer streams via the deezer.com web session.
//
// Flow (validated end-to-end against the live API, mirroring kmille/deezer-downloader):
//   1. GET https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData with the
//      arl cookie -> returns the account's license_token and web_sound_quality flags
//      (lossless = FLAC available on the subscription).
//   2. GET the public track page https://www.deezer.com/us/track/{id}; the SSR JSON
//      embeds DATA.TRACK_TOKEN (+ MD5_ORIGIN, FILESIZE_*). Without an ARL the page
//      still renders but only carries 30s-preview rights; with the ARL the token
//      unlocks the full track.
//   3. POST https://media.deezer.com/v1/get_url with the license_token + TRACK_TOKEN
//      -> a signed, unencrypted CDN URL for the whole file (FLAC or MP3 320).
//
// The token from step 2/3 is short-lived and per-request, so nothing is cached here:
// every call fetches fresh credentials. Why not api.deezer.com's /track/{id}?
// It only ever serves the 30-second preview and never exposes TRACK_TOKEN.
// ---------------------------------------------------------------------------

const USER_AGENT = 'Mozilla/5.0 (X11; Linux i686; rv:135.0) Gecko/20100101 Firefox/135.0';
// Deezer gates the streaming page by region; the US slug is stable for token extraction.
const DEEZER_PAGE_LOCALE = 'us';

type DeezerSoundQuality = {
    low?: boolean;
    standard?: boolean;
    high?: boolean;
    lossless?: boolean;
};

type DeezerUserData = {
    USER: {
        USER_ID?: number;
        OPTIONS?: {
            license_token?: string;
            web_sound_quality?: DeezerSoundQuality;
        };
    };
};

export type DeezerStreamQuality = 'FLAC' | 'MP3_320' | 'MP3_128';

// What the web session reports for this ARL: the best lossless tier plus the
// account's available formats, so callers can fall back before asking the CDN.
export type DeezerSessionInfo = {
    license_token: string;
    formats: DeezerStreamQuality[];
    best: DeezerStreamQuality;
    user_id?: number;
};

function proxyAgent() {
    if (process.env.SOCKS5_PROXY) return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    return undefined;
}

function getDeezerAxiosConfig(options: AxiosRequestConfig = {}): AxiosRequestConfig {
    const agent = proxyAgent();
    return {
        httpAgent: agent,
        httpsAgent: agent,
        headers: {
            Cookie: `arl=${process.env.DEEZER_ARL}; comeback=1`,
            'User-Agent': USER_AGENT,
            Origin: 'https://www.deezer.com',
            Referer: 'https://www.deezer.com/',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
            ...options.headers
        },
        ...options
    };
}

export function testForDeezerRequirements() {
    if (!process.env.DEEZER_ARL || process.env.DEEZER_ARL.length === 0) {
        throw new Error('Deployment is missing DEEZER_ARL environment variable. Get it from your Deezer session cookies (arl cookie).');
    }
    return true;
}

// One shared in-process session info holder: license_token and format flags are
// stable for the life of an ARL, only TRACK_TOKEN is per-request. Kept on
// globalThis because every route bundle gets its own copy of this module.
type SessionCache = { info: DeezerSessionInfo | null; fetchedAt: number };
const sessionCache: SessionCache = ((globalThis as any).__deezerSessionCache ??= { info: null, fetchedAt: 0 });
const SESSION_TTL_MS = 10 * 60 * 1000;

export async function getDeezerSession(options: AxiosRequestConfig = {}): Promise<DeezerSessionInfo> {
    testForDeezerRequirements();
    if (sessionCache.info && Date.now() - sessionCache.fetchedAt < SESSION_TTL_MS) return sessionCache.info;

    const response = await axios.get<any>(
        'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=',
        getDeezerAxiosConfig({ ...options, timeout: options.timeout ?? 15000 })
    );
    const user: DeezerUserData = response.data?.results;
    const licenseToken = user?.USER?.OPTIONS?.license_token;
    if (!user?.USER || !licenseToken) {
        throw new Error('Deezer: ARL cookie rejected or expired (no license_token). Refresh the DEEZER_ARL secret.');
    }
    const quality = user.USER.OPTIONS?.web_sound_quality ?? {};
    const formats: DeezerStreamQuality[] = [];
    if (quality.lossless) formats.push('FLAC');
    if (quality.high) formats.push('MP3_320');
    if (quality.standard) formats.push('MP3_128');
    const info: DeezerSessionInfo = {
        license_token: licenseToken,
        formats: formats.length ? formats : ['MP3_128'],
        best: formats[0] ?? 'MP3_128',
        user_id: user.USER.USER_ID
    };
    sessionCache.info = info;
    sessionCache.fetchedAt = Date.now();
    return info;
}

// The SSR payload of the track page. DATA embeds TRACK_TOKEN for the full stream,
// plus the same MD5_ORIGIN / FILESIZE_* fields the public API hides.
export type DeezerTrackStreamData = {
    SNG_ID: string;
    SNG_TITLE: string;
    ART_NAME?: string;
    ALB_TITLE?: string;
    DURATION: number;
    MD5_ORIGIN: string;
    MEDIA_VERSION?: string;
    TRACK_TOKEN: string;
    TRACK_TOKEN_EXPIRE?: number;
    FILESIZE_MP3_128?: string | number;
    FILESIZE_MP3_320?: string | number;
    FILESIZE_FLAC?: string | number;
    FALLBACK?: { SNG_ID: string; TRACK_TOKEN: string } | null;
};

export async function getDeezerTrackStreamData(trackId: string | number, options: AxiosRequestConfig = {}): Promise<DeezerTrackStreamData> {
    const target = `https://www.deezer.com/${DEEZER_PAGE_LOCALE}/track/${trackId}`;
    const response = await axios.get<string>(target, getDeezerAxiosConfig({ ...options, timeout: options.timeout ?? 15000 }));
    const match = response.data.match(/(\{"DATA":.{100,}?\})<\/script>/);
    if (!match) throw new Error(`Deezer: no stream data embedded for track ${trackId} (page layout changed or ARL logged out)`);
    const payload = JSON.parse(match[1]) as any;
    const data = payload?.DATA;
    if (!data || !data.TRACK_TOKEN) {
        // Not logged in / region-blocked pages render without DATA.TRACK_TOKEN.
        throw new Error(`Deezer: track ${trackId} returned no TRACK_TOKEN (expired ARL or region-locked track)`);
    }
    return { ...data, SNG_ID: String(data.SNG_ID ?? trackId) } as DeezerTrackStreamData;
}

function bestFormat(session: DeezerSessionInfo, quality: DeezerStreamQuality | undefined): DeezerStreamQuality {
    const candidates = quality ? [quality, ...session.formats] : session.formats;
    for (const candidate of candidates) {
        if (session.formats.includes(candidate)) return candidate;
    }
    return 'MP3_128';
}

// Exchange a TRACK_TOKEN for a signed, unencrypted CDN URL good for the whole file.
// `error` throws with the API's own message (e.g. "country not available").
export async function getDeezerStreamURL(
    trackToken: string,
    format: DeezerStreamQuality,
    licenseToken: string,
    options: AxiosRequestConfig = {}
): Promise<string> {
    const response = await axios.post<any>(
        'https://media.deezer.com/v1/get_url',
        {
            license_token: licenseToken,
            media: [{ type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format }] }],
            track_tokens: [trackToken]
        },
        { ...getDeezerAxiosConfig(options), timeout: options.timeout ?? 15000 }
    );
    const payload = response.data;
    const first = payload?.data?.[0];
    if (first?.errors?.length) throw new Error(`Deezer media error: ${first.errors[0]?.message || first.errors[0]?.code}`);
    const url = first?.media?.[0]?.sources?.find((s: any) => s?.url)?.url;
    if (!url) throw new Error('Deezer media error: no stream source returned');
    return url as string;
}

// Full flow: fresh session credentials + fresh TRACK_TOKEN -> full-length stream URL.
export async function getDeezerFullStreamURL(
    trackId: string | number,
    preferred: DeezerStreamQuality = 'FLAC',
    options: AxiosRequestConfig = {}
): Promise<{ url: string; format: DeezerStreamQuality; duration: number; title?: string; artist?: string }> {
    const [session, track] = await Promise.all([
        getDeezerSession(options),
        getDeezerTrackStreamData(trackId, options)
    ]);
    const format = bestFormat(session, preferred);
    try {
        return {
            url: await getDeezerStreamURL(track.TRACK_TOKEN, format, session.license_token, options),
            format,
            duration: Number(track.DURATION) || 0,
            title: track.SNG_TITLE,
            artist: track.ART_NAME
        };
    } catch (error) {
        // Token fallback: Deezer sometimes serves a different (available-country) track
        // via FALLBACK; retry there before giving up.
        if (track.FALLBACK?.TRACK_TOKEN) {
            return {
                url: await getDeezerStreamURL(track.FALLBACK.TRACK_TOKEN, format, session.license_token, options),
                format,
                duration: Number(track.DURATION) || 0,
                title: track.SNG_TITLE,
                artist: track.ART_NAME
            };
        }
        throw error;
    }
}

// Quality keys shared with the Qobuz download pipeline: FLAC -> MP3_320 -> MP3_128,
// in that order, based on what this ARL's subscription actually reports.
export function pickDeezerFormat(session: DeezerSessionInfo): DeezerStreamQuality {
    return session.best;
}

export async function getDeezerDownloadURL(trackId: string | number, quality: DeezerStreamQuality | '27' | '7' | '6' | '5' = '27', options: AxiosRequestConfig = {}): Promise<string | null> {
    const requested: DeezerStreamQuality = quality === '27' || quality === '6' ? 'FLAC' : quality === '7' ? 'MP3_320' : quality === '5' ? 'MP3_128' : (quality as DeezerStreamQuality);
    const { url } = await getDeezerFullStreamURL(trackId, requested, options);
    return url;
}

// Check if a track is downloadable (lossless/FLAC available with the current ARL)
export async function checkDeezerTrackAvailability(trackId: string | number, options: AxiosRequestConfig = {}) {
    const track = await getDeezerTrackStreamData(trackId, options);
    const size = (v?: string | number) => typeof v === 'string' ? Number(v) : (v ?? 0);
    return {
        track_type: 'track',
        rights: null,
        duration: Number(track.DURATION) || 0,
        title: track.SNG_TITLE,
        artist: track.ART_NAME,
        available_qualities: {
            mp3_128: (size(track.FILESIZE_MP3_128) || 0) > 0,
            mp3_320: (size(track.FILESIZE_MP3_320) || 0) > 0,
            flac: (size(track.FILESIZE_FLAC) || 0) > 0
        }
    };
}

export async function getDeezerTrackInfo(trackId: string | number, options: AxiosRequestConfig = {}) {
    const track = await getDeezerTrackStreamData(trackId, options);
    return {
        ...track,
        FILESIZE_FLAC: Number(track.FILESIZE_FLAC ?? 0) || 0,
        FILESIZE_MP3_320: Number(track.FILESIZE_MP3_320 ?? 0) || 0,
        FILESIZE_MP3_128: Number(track.FILESIZE_MP3_128 ?? 0) || 0
    };
}
