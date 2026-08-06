import { NextRequest, NextResponse } from 'next/server';
import { clearState, exchangeCodeForSession, getRedirectUri, verifyState, writeSession } from '@/lib/spotify-auth';
import { getRequestOrigin } from '@/lib/file-proxy';

export const dynamic = 'force-dynamic';

// Spotify redirects back here after the user approves (or denies) the login.
// Always lands back on the app itself — never on a caller-supplied URL.
export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const home = new URL('/', getRequestOrigin(request));

    const fail = (reason: string) => {
        home.searchParams.set('spotify', 'error');
        home.searchParams.set('spotify_error', reason);
        const response = NextResponse.redirect(home);
        clearState(response);
        return response;
    };

    if (params.get('error')) return fail(params.get('error')!);
    if (!verifyState(request, params.get('state'))) return fail('state_mismatch');

    const code = params.get('code');
    if (!code) return fail('missing_code');

    try {
        const session = await exchangeCodeForSession(code, getRedirectUri(request));
        home.searchParams.set('spotify', 'connected');
        const response = NextResponse.redirect(home);
        writeSession(response, session);
        clearState(response);
        return response;
    } catch (error: any) {
        return fail(error.message || 'token_exchange_failed');
    }
}
