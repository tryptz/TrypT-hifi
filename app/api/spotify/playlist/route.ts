import { NextRequest, NextResponse } from 'next/server';
import { getPlaylist } from '@/lib/spotify-server';
import { LIKED_SONGS_ID, parseSpotifyPlaylistId } from '@/lib/spotify';
import { persistSession, resolveUserSession } from '@/lib/spotify-auth';
import z from 'zod';

export const dynamic = 'force-dynamic';

// Either a pasted link (`url`) or a playlist picked from the user's library (`id`).
const playlistParamsSchema = z
    .object({
        url: z.string().optional(),
        id: z.string().optional()
    })
    .refine((params) => !!(params.url || params.id), { message: 'A Spotify playlist link is required' });

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { url, id } = playlistParamsSchema.parse(params);
        const playlistId = id === LIKED_SONGS_ID ? LIKED_SONGS_ID : id || parseSpotifyPlaylistId(url!);
        if (!playlistId) throw new Error('That does not look like a Spotify playlist link.');

        // Signed in? Use the user's token so private and collaborative playlists resolve.
        const resolved = await resolveUserSession(request).catch(() => ({ session: null, token: null, refreshed: false }));
        const data = await getPlaylist(playlistId, resolved.token);
        return persistSession(new NextResponse(JSON.stringify({ success: true, data }), { status: 200 }), resolved) as NextResponse;
    } catch (error: any) {
        return new NextResponse(
            JSON.stringify({
                success: false,
                error: error?.errors || error.message || 'An error occurred parsing the request.'
            }),
            { status: 400 }
        );
    }
}
