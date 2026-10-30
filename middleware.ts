import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, ACCESS_HEADER, ACCESS_QUERY, accessDigest, accessPassword, sameDigest } from './lib/access';

// The HiFi API Tryptify adds as its TIDAL server (app/search/route.ts and the rest).
const HIFI_PATHS = new Set([
    '/search', '/track', '/info', '/album', '/artist', '/artist/similar',
    '/lyrics', '/playlist', '/recommendations', '/trackManifests',
]);

// Open without the password: they carry their own proof.
function isOpen(pathname: string): boolean {
    return (
        pathname === '/unlock' ||
        // HMAC-signed links (lib/file-proxy.ts), handed out only by routes the password guards.
        pathname === '/api/file' ||
        // PUT needs X-Upload-Token; GET is signed (exp/sig).
        pathname.startsWith('/api/apple/files/') ||
        // The decrypt agent's queue, behind its own APPLE_JOB_QUEUE_TOKEN.
        pathname === '/api/apple/jobs' ||
        // A job's progress, by the job's own unguessable token.
        /^\/api\/apple\/job\/[^/]+$/.test(pathname) ||
        // A shared link's preview for Discord; answers only links this server signed (lib/share-server.ts).
        pathname === '/api/share/meta' ||
        pathname === '/api/share/preview' ||
        // Static files (the logo, ffmpeg's wasm, the PWA's icons).
        (!pathname.startsWith('/api/') && /\.[a-z0-9]+$/i.test(pathname))
    );
}

const DENIED = 'This server needs its password.';

export async function middleware(request: NextRequest) {
    const password = accessPassword();
    if (!password) return NextResponse.next();
    const { pathname, searchParams } = request.nextUrl;
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    // A browser's CORS preflight never carries the header it asks about.
    if (request.method === 'OPTIONS' || isOpen(path)) return NextResponse.next();

    const expected = await accessDigest(password);
    const given = request.headers.get(ACCESS_HEADER) ?? searchParams.get(ACCESS_QUERY);
    if (given && sameDigest(await accessDigest(given), expected)) return NextResponse.next();
    const cookie = request.cookies.get(ACCESS_COOKIE)?.value;
    if (cookie && sameDigest(cookie, expected)) return NextResponse.next();

    if (path.startsWith('/api/')) {
        // With CORS, so the web player can read the 401 and say what is wrong.
        return NextResponse.json({ success: false, error: DENIED }, {
            status: 401,
            headers: { 'Access-Control-Allow-Origin': '*' },
        });
    }
    if (HIFI_PATHS.has(path)) return NextResponse.json({ detail: DENIED }, { status: 401 });

    // The host the visitor asked for: behind the tunnel the standalone server's
    // own nextUrl names localhost, which would send them nowhere.
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
    const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(/:$/, '');
    const unlock = new URL('/unlock', `${proto}://${host}`);
    unlock.searchParams.set('next', pathname + request.nextUrl.search);
    return NextResponse.redirect(unlock);
}

export const config = {
    matcher: ['/((?!_next/).*)'],
};
