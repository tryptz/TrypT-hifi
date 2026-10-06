import { NextRequest } from 'next/server';
import { openAtmos } from '@/lib/tidal-atmos-server';
import { dashErrorResponse, serveDash } from '@/lib/tidal-dash-route';
import z from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Serves a TIDAL Dolby Atmos track assembled from its DASH segments (see
// lib/tidal-atmos-server.ts), untouched: the full bed + JOC objects + OAMD.
// HEAD, ranges and progressive first GETs as in lib/tidal-dash-route.ts, so a
// player (Tryptify) starts within a segment or two.
const paramsSchema = z.object({
    track_id: z.string().regex(/^\d{1,20}$/, 'ID must be numeric')
});

async function serve(request: NextRequest, method: 'GET' | 'HEAD') {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id } = paramsSchema.parse(params);
        return await serveDash(request, method, await openAtmos(track_id), { contentType: 'audio/mp4', filename: `${track_id}.m4a` });
    } catch (error: any) {
        return dashErrorResponse(error);
    }
}

export const GET = (request: NextRequest) => serve(request, 'GET');
export const HEAD = (request: NextRequest) => serve(request, 'HEAD');
