import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import type { DeezerStreamQuality } from './deezer-dl-server';

// Functions only to be used by servers
// Do not import this file into the client

const DEFAULT_TTL_SECONDS = 15 * 60;

function getSecret(): string {
    const secret = process.env.FILE_PROXY_SECRET || process.env.QOBUZ_SECRET;
    if (!secret) throw new Error('Deployment is missing FILE_PROXY_SECRET/QOBUZ_SECRET environment variable.');
    return secret;
}

// A link to a Deezer file that /api/file decrypts on the way (lib/deezer-decrypt.ts):
// the song's id makes the key, and its format the Content-Type.
export type DeezerFileSignature = { id: string; format: DeezerStreamQuality };

// A plain link signs `${url}\n${exp}`, as it always has. A Deezer link signs a
// longer string that also names the song, so neither can be passed off as the
// other, and the id cannot be changed or dropped.
function computeSignature(url: string, exp: number, deezer?: DeezerFileSignature): string {
    const signed = deezer ? `${url}\n${exp}\ndeezer:${deezer.id}:${deezer.format}` : `${url}\n${exp}`;
    return crypto.createHmac('sha256', getSecret()).update(signed).digest('hex');
}

export function getRequestOrigin(request: NextRequest): string {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || request.nextUrl.protocol.replace(':', '');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || request.nextUrl.host;
    return `${proto}://${host}`;
}

// The upstream URL is base64url-encoded so it stays an opaque token: proxies and
// framework URL normalization must not be able to alter the signed bytes.
export function signFileURL(upstreamUrl: string, origin: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
    return buildFileURL(upstreamUrl, origin, ttlSeconds);
}

// Same, for a striped Deezer CDN file: /api/file serves it decrypted, so a
// browser can play it. The id and format ride along as `deezer` and `format`.
export function signDeezerFileURL(upstreamUrl: string, origin: string, deezer: DeezerFileSignature, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
    return buildFileURL(upstreamUrl, origin, ttlSeconds, deezer);
}

function buildFileURL(upstreamUrl: string, origin: string, ttlSeconds: number, deezer?: DeezerFileSignature): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const proxied = new URL('/api/file', origin);
    proxied.searchParams.set('url', Buffer.from(upstreamUrl, 'utf8').toString('base64url'));
    proxied.searchParams.set('exp', exp.toString());
    if (deezer) {
        proxied.searchParams.set('deezer', deezer.id);
        proxied.searchParams.set('format', deezer.format);
    }
    proxied.searchParams.set('sig', computeSignature(upstreamUrl, exp, deezer));
    return proxied.toString();
}

export function verifyFileURL(url: string, exp: number, sig: string, deezer?: DeezerFileSignature): 'ok' | 'invalid' | 'expired' {
    const expected = Buffer.from(computeSignature(url, exp, deezer), 'hex');
    const provided = Buffer.from(sig, 'hex');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return 'invalid';
    if (exp < Math.floor(Date.now() / 1000)) return 'expired';
    return 'ok';
}
