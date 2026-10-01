import { NextRequest, NextResponse } from 'next/server';
import { getDeezerFullStreamURL } from '@/lib/deezer-dl-server';
import { getPreviewURL } from '@/lib/deezer-server';
import { getRequestOrigin, signFileURL } from '@/lib/file-proxy';
import z from 'zod';

export const dynamic = 'force-dynamic';

// Returns a signed /api/file link to the track's FULL-LENGTH stream (FLAC/MP3 via the
// ARL session), not the 30-second MP3 preview: the public-API preview is region-gated
// and often missing entirely for tracks the ARL account can stream in full.
const previewParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id } = previewParamsSchema.parse(params);
        // Full-length stream first; fall back to the legacy preview only if the ARL flow fails.
        try {
            const stream = await getDeezerFullStreamURL(track_id);
            const url = signFileURL(stream.url, getRequestOrigin(request));
            return new NextResponse(JSON.stringify({ success: true, data: { url } }), { status: 200 });
        } catch (streamError) {
            const previewUrl = await getPreviewURL(track_id);
            if (!previewUrl) throw streamError;
            const url = signFileURL(previewUrl, getRequestOrigin(request));
            return new NextResponse(JSON.stringify({ success: true, data: { url } }), { status: 200 });
        }
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
