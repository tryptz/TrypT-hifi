import { NextRequest, NextResponse } from 'next/server';
import { matchSpotifyTrack } from '@/lib/spotify-match';
import z from 'zod';

export const dynamic = 'force-dynamic';

// Matching happens one track at a time so the importer can show progress and
// stay well clear of request timeouts on large playlists.
const matchParamsSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    artists: z.string().default(''),
    album: z.string().default(''),
    isrc: z.string().default(''),
    explicit: z
        .string()
        .default('false')
        .transform((value) => value === 'true'),
    duration: z.preprocess((value) => (value === undefined || value === '' ? 0 : parseInt(value as string)), z.number().min(0).max(86400).default(0))
});

export async function GET(request: NextRequest) {
    const country = request.headers.get('Token-Country');
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { title, artists, album, isrc, explicit, duration } = matchParamsSchema.parse(params);
        const data = await matchSpotifyTrack(
            {
                id: isrc || title,
                title,
                // Pipe-separated: artist names themselves contain commas ("Tyler, The Creator").
                artists: artists
                    .split('|')
                    .map((artist) => artist.trim())
                    .filter(Boolean),
                album,
                isrc: isrc || null,
                duration,
                explicit,
                url: null
            },
            country ? { country } : {}
        );
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
