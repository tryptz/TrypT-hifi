import { NextRequest, NextResponse } from 'next/server';
import { getArtistReleases } from '@/lib/qobuz-dl-server';
import z from 'zod';

export const dynamic = 'force-dynamic';

// Query-string values always arrive as strings; coerce numeric params to int and
// treat an omitted/blank value as "use the default" (parseInt(undefined) -> NaN
// would otherwise 400 before .default() applies). offset is min(0) so the
// advertised default of 0 is actually accepted. Keeps the route honest with the
// /api descriptor so a client sending only artist_id gets the documented defaults.
const intParam = (schema: z.ZodNumber, def: number) =>
    z.preprocess((a) => (a === undefined || a === '' ? undefined : parseInt(a as string)), schema.default(def));

const releasesParamsSchema = z.object({
    artist_id: z.string().min(1, 'ID is required'),
    release_type: z.enum(['album', 'live', 'compilation', 'epSingle', 'download']).default('album'),
    track_size: intParam(z.number().positive(), 1000),
    offset: intParam(z.number().min(0), 0),
    limit: intParam(z.number().positive(), 10)
});

export async function GET(request: NextRequest) {
    const country = request.headers.get('Token-Country');
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { artist_id, release_type, track_size, offset, limit } = releasesParamsSchema.parse(params);
        const data = await getArtistReleases(artist_id, release_type, limit, offset, track_size, country ? { country } : {});
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
