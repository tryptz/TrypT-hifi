import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

// Functions only to be used by servers
// Do not import this file into the client

const DEFAULT_TTL_SECONDS = 15 * 60;

// Prefer FILE_PROXY_SECRET. The QOBUZ_SECRET fallback is legacy and a poor
// signing key: it is a *Qobuz-owned* value that rotates, and every rotation
// silently invalidates links already handed out. It is also no longer required
// for the Qobuz API itself (see lib/qobuz-credentials.ts), so a deployment that
// drops it must set FILE_PROXY_SECRET or file delivery stops here.
function getSecret(): string {
    const secret = process.env.FILE_PROXY_SECRET || process.env.QOBUZ_SECRET;
    if (!secret)
        throw new Error(
            'Deployment is missing FILE_PROXY_SECRET. Set it to any long random string — it signs /api/file URLs and is unrelated to Qobuz credentials.'
        );
    return secret;
}

function computeSignature(url: string, exp: number): string {
    return crypto.createHmac('sha256', getSecret()).update(`${url}\n${exp}`).digest('hex');
}

export function getRequestOrigin(request: NextRequest): string {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || request.nextUrl.protocol.replace(':', '');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || request.nextUrl.host;
    return `${proto}://${host}`;
}

// The upstream URL is base64url-encoded so it stays an opaque token: proxies and
// framework URL normalization must not be able to alter the signed bytes.
export function signFileURL(upstreamUrl: string, origin: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const proxied = new URL('/api/file', origin);
    proxied.searchParams.set('url', Buffer.from(upstreamUrl, 'utf8').toString('base64url'));
    proxied.searchParams.set('exp', exp.toString());
    proxied.searchParams.set('sig', computeSignature(upstreamUrl, exp));
    return proxied.toString();
}

export function verifyFileURL(url: string, exp: number, sig: string): 'ok' | 'invalid' | 'expired' {
    const expected = Buffer.from(computeSignature(url, exp), 'hex');
    const provided = Buffer.from(sig, 'hex');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return 'invalid';
    if (exp < Math.floor(Date.now() / 1000)) return 'expired';
    return 'ok';
}
