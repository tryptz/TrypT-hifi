import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { buildAuthorizeUrl, getRedirectUri, writeState } from '@/lib/spotify-auth';

export const dynamic = 'force-dynamic';

// Starts the Spotify login: a full-page redirect to Spotify's consent screen.
export async function GET(request: NextRequest) {
    try {
        const state = crypto.randomBytes(16).toString('hex');
        const response = NextResponse.redirect(buildAuthorizeUrl(getRedirectUri(request), state));
        writeState(response, state);
        return response;
    } catch (error: any) {
        return new NextResponse(
            JSON.stringify({
                success: false,
                error: error.message || 'An error occurred starting the Spotify login.'
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
