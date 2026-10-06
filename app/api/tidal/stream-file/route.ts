import { NextRequest } from 'next/server';
import { TIDAL_QUALITIES, openStream, streamFormat } from '@/lib/tidal-stream-server';
import { dashErrorResponse, serveDash } from '@/lib/tidal-dash-route';
import z from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Serves a TIDAL stereo track that TIDAL delivers as DASH segments, assembled
// into one file (see lib/tidal-stream-server.ts): a plain .flac for lossless,
// fragmented-MP4 AAC otherwise. /api/tidal/download-music hands out these links
// with the quality TIDAL actually delivered. HEAD, ranges and progressive first
// GETs as in lib/tidal-dash-route.ts.
const paramsSchema = z.object({
    track_id: z.string().regex(/^\d{1,20}$/, 'ID must be numeric'),
    quality: z.enum(TIDAL_QUALITIES)
});

async function serve(request: NextRequest, method: 'GET' | 'HEAD') {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, quality } = paramsSchema.parse(params);
        const { ext, contentType } = streamFormat(quality);
        return await serveDash(request, method, await openStream(track_id, quality), { contentType, filename: `${track_id}.${ext}` });
    } catch (error: any) {
        return dashErrorResponse(error);
    }
}

export const GET = (request: NextRequest) => serve(request, 'GET');
export const HEAD = (request: NextRequest) => serve(request, 'HEAD');
