import { getTokenForCountry, tokenCountriesMap } from '@/config/token-countries';
import { APIOptionProps, QobuzArtist, QobuzSearchResults } from './qobuz-dl';
import { makeProxyAgent, promoteSecret, refreshCredentials, resolveAppId, resolveCredentials } from './qobuz-credentials';
import axios from 'axios';

// Functions only to be used by servers
// Do not import this file into the client

const QOBUZ_ALBUM_URL_REGEX = /https:\/\/(play|open)\.qobuz\.com\/album\/[a-zA-Z0-9]+/;
const QOBUZ_TRACK_URL_REGEX = /https:\/\/(play|open)\.qobuz\.com\/track\/\d+/;
const QOBUZ_ARTIST_URL_REGEX = /https:\/\/(play|open)\.qobuz\.com\/artist\/\d+/;

let crypto: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    crypto = require('node:crypto');
}

export function testForRequirements() {
    // QOBUZ_APP_ID and QOBUZ_SECRET are deliberately NOT required: Qobuz rotates
    // both, so they are resolved from the live web player at runtime when unset
    // (see lib/qobuz-credentials.ts). Setting them still pins them.
    if (!process.env.QOBUZ_API_BASE || process.env.QOBUZ_API_BASE.length === 0) throw new Error('Deployment is missing QOBUZ_API_BASE environment variable.');
    
    if (!process.env.QOBUZ_AUTH_TOKENS || process.env.QOBUZ_AUTH_TOKENS.length === 0) throw new Error('Deployment is missing QOBUZ_AUTH_TOKENS environment variable.');
    
    // Check if it's an empty array string
    try {
        const tokens = JSON.parse(process.env.QOBUZ_AUTH_TOKENS);
        if (Array.isArray(tokens) && tokens.length === 0 && tokenCountriesMap.length === 0) {
            throw new Error('QOBUZ_AUTH_TOKENS is an empty array and no tokenCountriesMap is configured.');
        }
    } catch {
        // If it fails to parse as JSON but has content, that's fine, it will be treated as a single token.
    }
    
    return true;
}

export function getRandomToken() {
    if (tokenCountriesMap.length > 0) return tokenCountriesMap[0].token;

    const rawTokens = process.env.QOBUZ_AUTH_TOKENS!;
    let tokens: string[];
    try {
        tokens = JSON.parse(rawTokens);
        if (!Array.isArray(tokens)) {
            tokens = [rawTokens];
        }
    } catch {
        tokens = [rawTokens];
    }
    
    return tokens[Math.floor(Math.random() * tokens.length)];
}

export async function search(query: string, limit: number = 10, offset: number = 0, options?: APIOptionProps) {
    testForRequirements();
    const { country, ...requestOptions } = options || {};
    const token = country ? getTokenForCountry(country) : getRandomToken();
    const appId = await resolveAppId();

    // Test if query is a Qobuz URL
    let id: string | null = null;
    let switchTo: string | null = null;
    if (query.trim().match(QOBUZ_ALBUM_URL_REGEX)) {
        id = query.trim().match(QOBUZ_ALBUM_URL_REGEX)![0].replace('https://open', '').replace('https://play', '').replace('.qobuz.com/album/', '');
        switchTo = 'albums';
    } else if (query.trim().match(QOBUZ_TRACK_URL_REGEX)) {
        id = query.trim().match(QOBUZ_TRACK_URL_REGEX)![0].replace('https://open', '').replace('https://play', '').replace('.qobuz.com/track/', '');
        switchTo = 'tracks';
    } else if (query.trim().match(QOBUZ_ARTIST_URL_REGEX)) {
        id = query.trim().match(QOBUZ_ARTIST_URL_REGEX)![0].replace('https://open', '').replace('https://play', '').replace('.qobuz.com/artist/', '');
        switchTo = 'artists';
    }
    // Else, search Qobuz database for the song
    const url = new URL(process.env.QOBUZ_API_BASE + 'catalog/search');
    url.searchParams.append('query', id || query);
    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('offset', offset.toString());
    const proxyAgent = makeProxyAgent();
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': appId,
            'x-user-auth-token': token,
            'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : undefined
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        ...requestOptions
    });
    return {
        ...response.data,
        switchTo
    } as QobuzSearchResults;
}

export async function getArtist(artistId: string, options?: APIOptionProps): Promise<QobuzArtist | null> {
    testForRequirements();
    const { country, ...requestOptions } = options || {};
    const token = country ? getTokenForCountry(country) : getRandomToken();
    const appId = await resolveAppId();

    const url = new URL(process.env.QOBUZ_API_BASE + '/artist/page');
    const proxyAgent = makeProxyAgent();
    return (
        await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
            params: { artist_id: artistId, sort: 'release_date' },
            headers: {
                'x-app-id': appId,
                'x-user-auth-token': token,
                'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : undefined
            },
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            ...requestOptions
        })
    ).data;
}

export async function getArtistReleases(
    artist_id: string,
    release_type: string = 'album',
    limit: number = 10,
    offset: number = 0,
    track_size: number = 1000,
    options?: APIOptionProps
) {
    testForRequirements();
    const { country, ...requestOptions } = options || {};
    const token = country ? getTokenForCountry(country) : getRandomToken();
    const appId = await resolveAppId();

    const url = new URL(process.env.QOBUZ_API_BASE + 'artist/getReleasesList');
    url.searchParams.append('artist_id', artist_id);
    url.searchParams.append('release_type', release_type);
    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('offset', offset.toString());
    url.searchParams.append('track_size', track_size.toString());
    url.searchParams.append('sort', 'release_date');
    const proxyAgent = makeProxyAgent();
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': appId,
            'x-user-auth-token': token,
            'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : undefined
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        ...requestOptions
    });
    return response.data;
}

export async function getAlbumInfo(album_id: string, options?: APIOptionProps) {
    testForRequirements();
    const { country, ...requestOptions } = options || {};
    const token = country ? getTokenForCountry(country) : getRandomToken();
    const appId = await resolveAppId();

    const url = new URL(process.env.QOBUZ_API_BASE + 'album/get');
    url.searchParams.append('album_id', album_id);
    url.searchParams.append('extra', 'track_ids');
    const proxyAgent = makeProxyAgent();
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': appId,
            'x-user-auth-token': token,
            'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : undefined
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        ...requestOptions
    });
    return response.data;
}

// A rejected *signature* (or app id) means the credentials rotated and a fresh
// bundle read is worth trying. A 401 does not: that is the user auth token, and
// re-reading the bundle would not change it.
function isCredentialRejection(error: any): boolean {
    return error?.response?.status === 400;
}

async function requestFileUrl(
    trackID: number,
    quality: string,
    appId: string,
    secret: string,
    token: string,
    requestOptions: Record<string, unknown>
): Promise<string | undefined> {
    const timestamp = Math.floor(new Date().getTime() / 1000);
    const r_sig = `trackgetFileUrlformat_id${quality}intentstreamtrack_id${trackID}${timestamp}${secret}`;
    const r_sig_hashed = crypto.createHash('md5').update(r_sig).digest('hex');
    const url = new URL(process.env.QOBUZ_API_BASE + 'track/getFileUrl');
    url.searchParams.append('format_id', quality);
    url.searchParams.append('intent', 'stream');
    url.searchParams.append('track_id', trackID.toString());
    url.searchParams.append('request_ts', timestamp.toString());
    url.searchParams.append('request_sig', r_sig_hashed);
    const proxyAgent = makeProxyAgent();
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': appId,
            'x-user-auth-token': token,
            'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : undefined
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        ...requestOptions
    });
    return response.data?.url;
}

export async function getDownloadURL(trackID: number, quality: string, options?: APIOptionProps) {
    testForRequirements();
    const { country, ...requestOptions } = options || {};
    const token = country ? getTokenForCountry(country) : getRandomToken();

    // Qobuz publishes several signing secrets and keeps only some of them live,
    // so walk the candidates. Pass 1 uses whatever is pinned/cached; if every
    // candidate is rejected, pass 2 re-reads the live bundle — that second pass
    // is what heals a rotation without anyone editing an environment variable.
    let credentials = await resolveCredentials();
    let lastRejection: any;

    for (let attempt = 0; attempt < 2; attempt++) {
        for (const secret of credentials.secrets) {
            try {
                const fileUrl = await requestFileUrl(trackID, quality, credentials.appId, secret, token, requestOptions);
                if (fileUrl) {
                    promoteSecret(secret);
                    return fileUrl;
                }
                // Signed fine but Qobuz returned no url: the track is not
                // streamable at this quality (region, tier, or sample-only).
                throw new Error(`Qobuz returned no download url for track ${trackID} at quality ${quality}.`);
            } catch (error: any) {
                if (!isCredentialRejection(error)) throw error;
                lastRejection = error;
            }
        }
        if (attempt === 0) credentials = await refreshCredentials();
    }

    const detail = lastRejection?.response?.data?.message || lastRejection?.message || 'unknown error';
    throw new Error(
        `Qobuz rejected the request signature for track ${trackID} with every known app id/secret (last error: ${detail}). ` +
            'The credentials in the web-player bundle may have changed shape — check lib/qobuz-credentials.ts.'
    );
}
