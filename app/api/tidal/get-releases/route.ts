import { NextRequest, NextResponse } from 'next/server';
import { getArtistReleases } from '@/lib/tidal-server';
import z from 'zod';

export const dynamic = 'force-dynamic';

const releasesParamsSchema = z.object({
    artist_id: z.string().regex(/^\d+$/, 'ID must be numeric'),
    release_type: z.enum(['album', 'live', 'compilation', 'epSingle', 'download']).default('album'),
    offset: z.preprocess((a) => parseInt(a as string), z.number().min(0).default(0)),
    limit: z.preprocess((a) => parseInt(a as string), z.number().positive().default(10))
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { artist_id, release_type, offset, limit } = releasesParamsSchema.parse(params);
        const data = await getArtistReleases(artist_id, release_type, limit, offset);
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
