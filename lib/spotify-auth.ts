import axios from 'axios';
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createSpotifyProxyAgent, testForSpotifyRequirements } from './spotify-server';
import { getRequestOrigin } from './file-proxy';

// Spotify user login (OAuth 2.0 authorization code flow).
// Functions only to be used by servers
// Do not import this file into the client

// Overridable so a deployment can route the OAuth endpoints through a mirror;
// defaults to Spotify's own accounts service.
const SPOTIFY_ACCOUNTS_BASE = (process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com').replace(/\/$/, '');
const SPOTIFY_TOKEN_URL = `${SPOTIFY_ACCOUNTS_BASE}/api/token`;
const SPOTIFY_AUTHORIZE_URL = `${SPOTIFY_ACCOUNTS_BASE}/authorize`;

export const SPOTIFY_SESSION_COOKIE = 'spotify_session';
export const SPOTIFY_STATE_COOKIE = 'spotify_auth_state';

// Read-only scopes: the importer lists the user's own playlists and their
// saved tracks, and never writes anything back to Spotify.
export const SPOTIFY_SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'user-read-private'].join(' ');

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const STATE_MAX_AGE = 60 * 10;

export type SpotifySession = {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number;
};

// The session cookie is encrypted rather than merely httpOnly so that a leaked
// cookie value can't be replayed against Spotify's API outside this deployment.
function sessionKey(): Buffer {
    const secret = process.env.FILE_PROXY_SECRET || process.env.SPOTIFY_CLIENT_SECRET || process.env.QOBUZ_SECRET;
    if (!secret) throw new Error('Deployment is missing FILE_PROXY_SECRET/SPOTIFY_CLIENT_SECRET environment variable.');
    return crypto.createHash('sha256').update(secret).digest();
}

function encryptSession(session: SpotifySession): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptSession(value: string): SpotifySession | null {
    try {
        const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
        if (!iv || !tag || !encrypted) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey(), iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
        const session = JSON.parse(decrypted);
        if (!session?.accessToken) return null;
        return session as SpotifySession;
    } catch {
        return null;
    }
}

// Spotify only redirects back to URIs registered on the app, so deployments
// behind a custom domain must pin it with SPOTIFY_REDIRECT_URI.
export function getRedirectUri(request: NextRequest): string {
    if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
    return new URL('/api/spotify/auth/callback', getRequestOrigin(request)).toString();
}

export function buildAuthorizeUrl(redirectUri: string, state: string): string {
    testForSpotifyRequirements();
    const url = new URL(SPOTIFY_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.SPOTIFY_CLIENT_ID!);
    url.searchParams.set('scope', SPOTIFY_SCOPES);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
}

async function requestTokens(body: Record<string, string>): Promise<SpotifySession> {
    testForSpotifyRequirements();
    const proxyAgent = createSpotifyProxyAgent();
    const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    try {
        const response = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams(body).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${credentials}`
            },
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent
        });
        return {
            accessToken: response.data.access_token,
            refreshToken: response.data.refresh_token ?? null,
            expiresAt: Date.now() + (response.data.expires_in ?? 3600) * 1000
        };
    } catch (error: any) {
        const description = error?.response?.data?.error_description || error?.response?.data?.error;
        throw new Error(description ? `Spotify login failed: ${description}` : `Spotify login failed: ${error?.message || 'unknown error'}`);
    }
}

export async function exchangeCodeForSession(code: string, redirectUri: string): Promise<SpotifySession> {
    return requestTokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

export function readSession(request: NextRequest): SpotifySession | null {
    const cookie = request.cookies.get(SPOTIFY_SESSION_COOKIE)?.value;
    return cookie ? decryptSession(cookie) : null;
}

export function writeSession(response: NextResponse, session: SpotifySession) {
    response.cookies.set({
        name: SPOTIFY_SESSION_COOKIE,
        value: encryptSession(session),
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE
    });
}

export function clearSession(response: NextResponse) {
    response.cookies.set({
        name: SPOTIFY_SESSION_COOKIE,
        value: '',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0
    });
}

export function writeState(response: NextResponse, state: string) {
    response.cookies.set({
        name: SPOTIFY_STATE_COOKIE,
        value: state,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: STATE_MAX_AGE
    });
}

export function clearState(response: NextResponse) {
    response.cookies.set({
        name: SPOTIFY_STATE_COOKIE,
        value: '',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0
    });
}

export function verifyState(request: NextRequest, state: string | null): boolean {
    const expected = request.cookies.get(SPOTIFY_STATE_COOKIE)?.value;
    if (!expected || !state || expected.length !== state.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(state));
}

// Resolves the signed-in user's access token, refreshing it when it has aged
// out. `refreshed` tells the caller to persist the rotated session.
export async function resolveUserSession(request: NextRequest): Promise<{ session: SpotifySession | null; token: string | null; refreshed: boolean }> {
    const session = readSession(request);
    if (!session) return { session: null, token: null, refreshed: false };
    if (session.expiresAt > Date.now() + 30000) return { session, token: session.accessToken, refreshed: false };
    if (!session.refreshToken) return { session: null, token: null, refreshed: false };

    const refreshedSession = await requestTokens({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
    // Spotify only returns a new refresh token some of the time; keep the old one otherwise.
    const merged = { ...refreshedSession, refreshToken: refreshedSession.refreshToken ?? session.refreshToken };
    return { session: merged, token: merged.accessToken, refreshed: true };
}

// Persists a rotated session onto the outgoing response.
export function persistSession(response: NextResponse, resolved: { session: SpotifySession | null; refreshed: boolean }) {
    if (resolved.refreshed && resolved.session) writeSession(response, resolved.session);
    return response;
}
