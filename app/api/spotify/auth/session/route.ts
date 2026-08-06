import { NextRequest, NextResponse } from 'next/server';
import { clearSession, persistSession, resolveUserSession } from '@/lib/spotify-auth';
import { getCurrentUser, testForSpotifyRequirements } from '@/lib/spotify-server';

export const dynamic = 'force-dynamic';

// Who, if anyone, is signed in. `configured` lets the UI explain that login is
// unavailable on a deployment without Spotify credentials.
export async function GET(request: NextRequest) {
    let configured = true;
    try {
        testForSpotifyRequirements();
    } catch {
        configured = false;
    }

    if (!configured) return NextResponse.json({ success: true, data: { configured: false, authenticated: false, user: null } });

    try {
        const resolved = await resolveUserSession(request);
        if (!resolved.token) return NextResponse.json({ success: true, data: { configured: true, authenticated: false, user: null } });
        const user = await getCurrentUser(resolved.token);
        return persistSession(NextResponse.json({ success: true, data: { configured: true, authenticated: true, user } }), resolved);
    } catch {
        // A revoked or otherwise unusable session should log the user back out
        // rather than wedging the importer.
        const response = NextResponse.json({ success: true, data: { configured: true, authenticated: false, user: null } });
        clearSession(response);
        return response;
    }
}

// Logging out only drops this deployment's cookie; it does not revoke the
// app's access, which the user manages from their Spotify account page.
export async function POST() {
    const response = NextResponse.json({ success: true, data: { configured: true, authenticated: false, user: null } });
    clearSession(response);
    return response;
}
