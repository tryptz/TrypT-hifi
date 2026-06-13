import { getTokenForCountry, tokenCountriesMap } from '@/config/token-countries';
import { APIOptionProps, QobuzArtist, QobuzSearchResults } from './qobuz-dl';
import { getRandomPoolToken, hasTokens } from './token-store';
import axios from 'axios';

// Functions only to be used by servers
// Do not import this file into the client

const QOBUZ_ALBUM_URL_REGEX = /https:\/\/(play|open)\.qobuz\.com\/album\/[a-zA-Z0-9]+/;
const QOBUZ_TRACK_URL_REGEX = /https:\/\/(play|open)\.qobuz\.com\/track\/\d+/;
const QOBUZ_ARTIST_URL_REGEX = /https:\/\/(play|open)\.qobuz\.com\/artist\/\d+/;

let crypto: any;
let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    crypto = require('node:crypto');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

// App-level config required for any Qobuz call (does NOT require an existing
// auth token — used by the login/validate flow, which produces tokens).
export function testAppRequirements() {
    if (!process.env.QOBUZ_APP_ID || process.env.QOBUZ_APP_ID.length === 0) throw new Error('Deployment is missing QOBUZ_APP_ID environment variable.');
    if (!process.env.QOBUZ_SECRET || process.env.QOBUZ_SECRET.length === 0) throw new Error('Deployment is missing QOBUZ_SECRET environment variable.');
    if (!process.env.QOBUZ_API_BASE || process.env.QOBUZ_API_BASE.length === 0) throw new Error('Deployment is missing QOBUZ_API_BASE environment variable.');
    return true;
}

export function testForRequirements() {
    testAppRequirements();

    // A token may come from the static tokenCountriesMap config or from the
    // runtime token store (seeded from QOBUZ_AUTH_TOKENS, then managed live via
    // the Qobuz Account settings UI).
    if (tokenCountriesMap.length === 0 && !hasTokens()) {
        throw new Error('No Qobuz auth token configured. Add one in Settings → Qobuz Account.');
    }

    return true;
}

export function getRandomToken() {
    if (tokenCountriesMap.length > 0) return tokenCountriesMap[0].token;

    const token = getRandomPoolToken();
    if (!token) throw new Error('No Qobuz auth token configured. Add one in Settings → Qobuz Account.');
    return token;
}

const QOBUZ_LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:83.0) Gecko/20100101 Firefox/83.0';

function buildProxyAgent() {
    if (process.env.SOCKS5_PROXY) {
        return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    }
    return undefined;
}

// Error carrying an HTTP status so the API routes can surface the correct code
// (e.g. 401 for bad credentials) instead of a blanket 400.
function statusError(message: string, status: number): Error {
    return Object.assign(new Error(message), { status });
}

// Exchange a Qobuz account email + password for a user_auth_token.
// Password is sent as the md5 hex digest (the canonical Qobuz form); if Qobuz
// rejects that with a 401 we retry once with the raw plaintext password, which
// the API also accepts, before treating it as a credential failure.
export async function qobuzLogin(email: string, password: string): Promise<{ token: string; user: any }> {
    testAppRequirements();

    const md5Password = crypto.createHash('md5').update(password).digest('hex');

    const attempt = async (passwordValue: string) => {
        const url = new URL(process.env.QOBUZ_API_BASE + 'user/login');
        url.searchParams.append('email', email);
        url.searchParams.append('password', passwordValue);
        const proxyAgent = buildProxyAgent();
        return axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
            headers: {
                'x-app-id': process.env.QOBUZ_APP_ID!,
                'User-Agent': QOBUZ_LOGIN_UA
            },
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            // We map the status codes ourselves below.
            validateStatus: () => true
        });
    };

    let response = await attempt(md5Password);
    if (response.status === 401) {
        // Fallback: some app_id/account combos accept only the plaintext form.
        response = await attempt(password);
    }

    if (response.status === 400) {
        throw statusError('Server misconfigured: invalid QOBUZ_APP_ID.', 500);
    }
    if (response.status === 401) {
        throw statusError('Invalid email or password.', 401);
    }
    if (response.status < 200 || response.status >= 300) {
        throw statusError('Qobuz login failed (HTTP ' + response.status + ').', 502);
    }

    const token = response.data?.user_auth_token;
    if (!token) {
        throw statusError('Qobuz did not return an auth token.', 502);
    }
    if (!response.data?.user?.credential?.parameters) {
        throw statusError('This Qobuz account is not eligible for Hi-Fi downloads (free account).', 403);
    }

    return { token, user: response.data.user };
}

// Validate an arbitrary (pasted) token by hitting a lightweight authenticated
// endpoint. 200 => valid, 401 => invalid/expired, 400 => bad app id.
// NOTE: catalog/search succeeds for free (download-ineligible) accounts too, so
// this confirms the token *authenticates* but — unlike qobuzLogin — cannot
// assert Hi-Fi eligibility (Qobuz exposes credential.parameters only via the
// login response, which needs the account's user_id, not just a pasted token).
export async function validateToken(token: string): Promise<true> {
    testAppRequirements();

    const url = new URL(process.env.QOBUZ_API_BASE + 'catalog/search');
    url.searchParams.append('query', 'test');
    url.searchParams.append('limit', '1');
    const proxyAgent = buildProxyAgent();
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': process.env.QOBUZ_APP_ID!,
            'x-user-auth-token': token,
            'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : QOBUZ_LOGIN_UA
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        validateStatus: () => true
    });

    if (response.status === 400) throw statusError('Server misconfigured: invalid QOBUZ_APP_ID.', 500);
    if (response.status === 401) throw statusError('Token is invalid or expired.', 401);
    if (response.status < 200 || response.status >= 300) throw statusError('Could not validate token (HTTP ' + response.status + ').', 502);
    return true;
}

export async function search(query: string, limit: number = 10, offset: number = 0, options?: APIOptionProps) {
    testForRequirements();
    const { country, ...requestOptions } = options || {};
    const token = country ? getTokenForCountry(country) : getRandomToken();

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
    let proxyAgent = undefined;
    if (process.env.SOCKS5_PROXY) {
        proxyAgent = new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    }
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': process.env.QOBUZ_APP_ID!,
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

    const url = new URL(process.env.QOBUZ_API_BASE + '/artist/page');
    let proxyAgent = undefined;
    if (process.env.SOCKS5_PROXY) {
        proxyAgent = new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    }
    return (
        await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
            params: { artist_id: artistId, sort: 'release_date' },
            headers: {
                'x-app-id': process.env.QOBUZ_APP_ID!,
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

    const url = new URL(process.env.QOBUZ_API_BASE + 'artist/getReleasesList');
    url.searchParams.append('artist_id', artist_id);
    url.searchParams.append('release_type', release_type);
    url.searchParams.append('limit', limit.toString());
    url.searchParams.append('offset', offset.toString());
    url.searchParams.append('track_size', track_size.toString());
    url.searchParams.append('sort', 'release_date');
    let proxyAgent = undefined;
    if (process.env.SOCKS5_PROXY) {
        proxyAgent = new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    }
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': process.env.QOBUZ_APP_ID!,
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

    const url = new URL(process.env.QOBUZ_API_BASE + 'album/get');
    url.searchParams.append('album_id', album_id);
    url.searchParams.append('extra', 'track_ids');
    let proxyAgent = undefined;
    if (process.env.SOCKS5_PROXY) {
        proxyAgent = new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    }
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': process.env.QOBUZ_APP_ID!,
            'x-user-auth-token': token,
            'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : undefined
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        ...requestOptions
    });
    return response.data;
}

export async function getDownloadURL(trackID: number, quality: string, options?: APIOptionProps) {
    testForRequirements();
    const { country, ...requestOptions } = options || {};
    const token = country ? getTokenForCountry(country) : getRandomToken();

    const timestamp = Math.floor(new Date().getTime() / 1000);
    const r_sig = `trackgetFileUrlformat_id${quality}intentstreamtrack_id${trackID}${timestamp}${process.env.QOBUZ_SECRET}`;
    const r_sig_hashed = crypto.createHash('md5').update(r_sig).digest('hex');
    const url = new URL(process.env.QOBUZ_API_BASE + 'track/getFileUrl');
    url.searchParams.append('format_id', quality);
    url.searchParams.append('intent', 'stream');
    url.searchParams.append('track_id', trackID.toString());
    url.searchParams.append('request_ts', timestamp.toString());
    url.searchParams.append('request_sig', r_sig_hashed);
    let proxyAgent = undefined;
    if (process.env.SOCKS5_PROXY) {
        proxyAgent = new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
    }
    const response = await axios.get(process.env.CORS_PROXY ? process.env.CORS_PROXY + encodeURIComponent(url.toString()) : url.toString(), {
        headers: {
            'x-app-id': process.env.QOBUZ_APP_ID!,
            'x-user-auth-token': token,
            'User-Agent': process.env.CORS_PROXY ? 'Qobuz-DL' : undefined
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        ...requestOptions
    });
    return response.data.url;
}
