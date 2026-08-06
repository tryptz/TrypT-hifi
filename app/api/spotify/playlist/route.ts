import { NextRequest, NextResponse } from 'next/server';
import { getPlaylist } from '@/lib/spotify-server';
import { parseSpotifyPlaylistId } from '@/lib/spotify';
import z from 'zod';

export const dynamic = 'force-dynamic';

const playlistParamsSchema = z.object({
    url: z.string().min(1, 'A Spotify playlist link is required')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { url } = playlistParamsSchema.parse(params);
        const playlistId = parseSpotifyPlaylistId(url);
        if (!playlistId) throw new Error('That does not look like a Spotify playlist link.');
        const data = await getPlaylist(playlistId);
        return new NextResponse(JSON.stringify({ success: true, data }), { status: 200 });
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
