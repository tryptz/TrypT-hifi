import { getArtist } from '@/lib/tidal-server';
import z from 'zod';

export const dynamic = 'force-dynamic';

const artistParamsSchema = z.object({
    artist_id: z.string().regex(/^\d+$/, 'ID must be numeric')
});

export async function GET(request: Request) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { artist_id } = artistParamsSchema.parse(params);
        const artist = await getArtist(artist_id);
        return new Response(JSON.stringify({ success: true, data: { artist } }), { status: 200 });
    } catch (error: any) {
        return new Response(
            JSON.stringify({
                success: false,
                error: error?.errors || error.message || 'An error occurred parsing the request.'
            }),
            { status: 400 }
        );
    }
}
