import { NextRequest, NextResponse } from 'next/server';
import { getLikedSongsSummary, getUserPlaylists } from '@/lib/spotify-server';
import { persistSession, resolveUserSession } from '@/lib/spotify-auth';
import z from 'zod';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
    offset: z.preprocess((value) => (value === undefined || value === '' ? 0 : parseInt(value as string)), z.number().min(0).max(10000).default(0))
});

// The signed-in user's own playlist library, which is what the importer's
// playlist picker browses.
export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { offset } = paramsSchema.parse(params);
        const resolved = await resolveUserSession(request);
        if (!resolved.token) return NextResponse.json({ success: false, error: 'Sign in with Spotify to see your playlists.' }, { status: 401 });

        const page = await getUserPlaylists(resolved.token, offset);
        // Liked Songs isn't returned by /me/playlists, so it is pinned to the top of the first page.
        const liked = offset === 0 ? await getLikedSongsSummary(resolved.token).catch(() => null) : null;
        const items = liked ? [liked, ...page.items] : page.items;

        return persistSession(NextResponse.json({ success: true, data: { ...page, items } }), resolved);
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error?.errors || error.message || 'An error occurred parsing the request.' }, { status: 400 });
    }
}
