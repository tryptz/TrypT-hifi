import axios, { AxiosRequestConfig } from 'axios';

// Functions only to be used by servers
// Do not import this file into the client

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const DEEZER_API_BASE = () => process.env.DEEZER_API_BASE || 'https://api.deezer.com';

// Deezer quality mapping:
// 1 = MP3 128, 3 = MP3 320, 9 = FLAC (lossless)
const DEEZER_QUALITY_MAP = {
    '5': 1,   // MP3 128 (free tier)
    '7': 3,   // MP3 320 (premium)
    '6': 9,   // FLAC (HiFi)
    '27': 9   // FLAC (HiFi) - matches Qobuz '27' default
} as const;

type DeezerQualityKey = keyof typeof DEEZER_QUALITY_MAP;

export function testForDeezerRequirements() {
    if (!process.env.DEEZER_ARL || process.env.DEEZER_ARL.length === 0) {
        throw new Error('Deployment is missing DEEZER_ARL environment variable. Get it from your Deezer session cookies (arl cookie).');
    }
    return true;
}

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
            Cookie: `arl=${process.env.DEEZER_ARL}`,
            'User-Agent': 'Deezer/5.30.300 (Windows; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            ...options.headers
        },
        ...options
    };
}

// Deezer track media response types
type DeezerMediaTrack = {
    TRACK_ID: string;
    SNG_ID: string;
    MD5_ORIGIN: string;
    FILE_SIZE: number;
    FILE_SIZE_MP3_128: number;
    FILE_SIZE_MP3_320: number;
    FILE_SIZE_FLAC: number;
    DURATION: string;
    // streaming URLs
    MEDIA_VERSION?: string;
    ERROR?: string;
};

type DeezerGetMediaResponse = {
    error?: string;
    data?: DeezerMediaTrack[];
    TRACK_TOKEN?: string;
    // fallback structure
    results?: DeezerMediaTrack[];
};

export async function getDeezerDownloadURL(trackId: string | number, quality: DeezerQualityKey = '27', options: AxiosRequestConfig = {}): Promise<string | null> {
    testForDeezerRequirements();

    const deezerQuality = DEEZER_QUALITY_MAP[quality];
    if (!deezerQuality) throw new Error(`Invalid quality: ${quality}. Valid: ${Object.keys(DEEZER_QUALITY_MAP).join(', ')}`);

    // Deezer's getMedia endpoint returns streaming URLs for a track
    const url = new URL(DEEZER_API_BASE().replace(/\/$/, '') + '/song/getData');
    url.searchParams.append('sng_id', String(trackId));
    url.searchParams.append('framed', '0'); // unframed = full stream
    url.searchParams.append('quality', String(deezerQuality));

    const config = getDeezerAxiosConfig(options);
    const target = process.env.CORS_PROXY
        ? process.env.CORS_PROXY + encodeURIComponent(url.toString())
        : url.toString();

    const response = await axios.get<DeezerGetMediaResponse>(target, config);

    // Parse response - Deezer returns different structures
    const data = response.data;

    // Check for errors
    if (data.error) {
        throw new Error(`Deezer: ${data.error}`);
    }

    // The response can be an array of media objects
    const mediaList = data.data || data.results || data;
    if (!Array.isArray(mediaList) || mediaList.length === 0) {
        // Try alternative endpoint
        return getDeezerDownloadURLAlternative(trackId, deezerQuality, options);
    }

    const media = mediaList[0];
    if (media.ERROR) {
        throw new Error(`Deezer media error: ${media.ERROR}`);
    }

    // Construct the streaming URL
    // Deezer uses a specific URL format with the MD5_ORIGIN and track token
    const md5Origin = media.MD5_ORIGIN;
    const trackToken = data.TRACK_TOKEN || media.MEDIA_VERSION;
    
    if (!md5Origin) {
        return getDeezerDownloadURLAlternative(trackId, deezerQuality, options);
    }

    // Build the CDN URL
    // Format: https://e-cdns-proxy-XX.dzcdn.net/mobile/1/{md5_origin}?track_token={token}&...
    const cdnUrl = buildDeezerCDNUrl(md5Origin, String(trackId), trackToken, deezerQuality);
    return cdnUrl;
}

function buildDeezerCDNUrl(md5Origin: string, trackId: string, token: string | undefined, quality: number): string {
    // Deezer CDN URL format
    // The token is needed for authenticated streams
    const baseHost = 'e-cdns-proxy-' + (Math.floor(Math.random() * 5) + 1) + '.dzcdn.net';
    let url = `https://${baseHost}/mobile/1/${md5Origin}`;
    
    const params = new URLSearchParams();
    params.append('track_id', trackId);
    if (token) params.append('track_token', token);
    params.append('quality', String(quality));
    params.append('framed', '0');
    
    return url + '?' + params.toString();
}

async function getDeezerDownloadURLAlternative(trackId: string | number, quality: number, options: AxiosRequestConfig = {}): Promise<string | null> {
    // Alternative: use the media endpoint
    const url = new URL(DEEZER_API_BASE().replace(/\/$/, '') + '/track/' + trackId);
    
    const config = getDeezerAxiosConfig(options);
    const target = process.env.CORS_PROXY
        ? process.env.CORS_PROXY + encodeURIComponent(url.toString())
        : url.toString();

    const response = await axios.get<any>(target, config);
    const track = response.data;

    if (track.error) {
        throw new Error(`Deezer: ${track.error}`);
    }

    // Check if track has media info
    if (track.MD5_ORIGIN && track.TRACK_TOKEN) {
        return buildDeezerCDNUrl(track.MD5_ORIGIN, String(trackId), track.TRACK_TOKEN, quality);
    }

    // Last resort: try the getMedia endpoint directly
    const mediaUrl = new URL(DEEZER_API_BASE().replace(/\/$/, '') + '/media/getMedia');
    mediaUrl.searchParams.append('track_ids', String(trackId));
    mediaUrl.searchParams.append('quality', String(quality));
    
    const mediaResponse = await axios.get<any>(target, getDeezerAxiosConfig(options));
    const mediaData = mediaResponse.data;
    
    if (Array.isArray(mediaData) && mediaData.length > 0) {
        const media = mediaData[0];
        if (media.MD5_ORIGIN && media.TRACK_TOKEN) {
            return buildDeezerCDNUrl(media.MD5_ORIGIN, String(trackId), media.TRACK_TOKEN, quality);
        }
    }

    return null;
}

export async function getDeezerTrackInfo(trackId: string | number, options: AxiosRequestConfig = {}) {
    testForDeezerRequirements();
    
    const url = new URL(DEEZER_API_BASE().replace(/\/$/, '') + '/track/' + trackId);
    const config = getDeezerAxiosConfig(options);
    const target = process.env.CORS_PROXY
        ? process.env.CORS_PROXY + encodeURIComponent(url.toString())
        : url.toString();

    const response = await axios.get(target, config);
    
    if (response.data.error) {
        throw new Error(`Deezer: ${response.data.error}`);
    }
    
    return response.data;
}

// Check if a track is downloadable (has lossless/FLAC available with the current ARL)
export async function checkDeezerTrackAvailability(trackId: string | number, options: AxiosRequestConfig = {}) {
    const track = await getDeezerTrackInfo(trackId, options);
    // TRACK_TYPE: 0=preview only, 1=downloadable, 2=streamable
    // RIGHTS: contains streaming rights
    return {
        track_type: track.TRACK_TYPE,
        rights: track.RIGHTS,
        available_qualities: {
            mp3_128: track.FILE_SIZE_MP3_128 > 0,
            mp3_320: track.FILE_SIZE_MP3_320 > 0,
            flac: track.FILE_SIZE_FLAC > 0
        }
    };
}