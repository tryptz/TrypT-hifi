import { NextRequest, NextResponse } from 'next/server';
import { getPreviewURL } from '@/lib/deezer-server';
import { getRequestOrigin, signFileURL } from '@/lib/file-proxy';
import z from 'zod';

export const dynamic = 'force-dynamic';

// Returns a signed /api/file link to the track's 30-second MP3 preview, the same
// shape /api/download-music returns, so the player can stream it with Range support.
const previewParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id } = previewParamsSchema.parse(params);
        const previewUrl = await getPreviewURL(track_id);
        if (!previewUrl) throw new Error('This track has no preview available.');
        const url = signFileURL(previewUrl, getRequestOrigin(request));
        return new NextResponse(JSON.stringify({ success: true, data: { url } }), { status: 200 });
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
