import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

// Server-only guard for mutating, instance-scoped endpoints (token management).
//
// The global CORS config in next.config.ts sets Access-Control-Allow-Origin: *
// on /api/:path*, which is fine for the read-only catalog endpoints but means
// any client could hit the token endpoints. These endpoints are meant to be
// driven only by the app's own settings UI (same-origin), so we verify the
// request originates from this instance's own page.
//
// For state-changing requests (POST/PUT/PATCH/DELETE) we REQUIRE a same-origin
// Origin (or Referer) header — a request with neither is treated as untrusted,
// which blocks non-browser clients on the network from silently managing tokens.
// For read-only GETs we only reject on an explicit cross-origin mismatch
// (browsers may legitimately omit Origin on a same-origin GET).
//
// Optionally, if QOBUZ_ADMIN_SECRET is set, the request must ALSO carry a
// matching x-admin-secret header — useful when operators expose the API directly
// rather than only through the same-origin UI.

export class ApiGuardError extends Error {
    status: number;
    constructor(message: string, status = 403) {
        super(message);
        this.name = 'ApiGuardError';
        this.status = status;
    }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The host the public origin should match. Behind a reverse proxy the real
// Host header is the internal upstream (e.g. localhost:3000), so prefer the
// proxy-supplied X-Forwarded-Host when present.
function trustedHost(request: NextRequest): string | null {
    return request.headers.get('x-forwarded-host') || request.headers.get('host');
}

function hostFromUrl(value: string | null): string | null {
    if (!value) return null;
    try {
        return new URL(value).host;
    } catch {
        return null;
    }
}

function constantTimeEquals(a: string, b: string): boolean {
    // Hash both sides so the comparison is over equal-length buffers regardless
    // of the inputs' lengths, then compare in constant time.
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

export function assertSameOrigin(request: NextRequest): void {
    const host = trustedHost(request);
    const isMutating = MUTATING_METHODS.has(request.method.toUpperCase());

    // Prefer Origin; fall back to the Referer's host (some clients send only Referer).
    const requestHost = hostFromUrl(request.headers.get('origin')) ?? hostFromUrl(request.headers.get('referer'));

    if (requestHost) {
        if (!host || requestHost !== host) {
            throw new ApiGuardError('Cross-origin requests are not allowed for this endpoint.');
        }
    } else if (isMutating) {
        // State-changing request with no Origin/Referer to verify: untrusted.
        throw new ApiGuardError('Missing Origin/Referer; this endpoint only accepts same-origin requests.');
    }

    const secret = process.env.QOBUZ_ADMIN_SECRET;
    if (secret) {
        const provided = request.headers.get('x-admin-secret');
        if (!provided || !constantTimeEquals(provided, secret)) {
            throw new ApiGuardError('Unauthorized.', 401);
        }
    }
}
