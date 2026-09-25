import { NextRequest, NextResponse } from 'next/server';
import { getStreamURL } from '@/lib/tidal-server';
import { getRequestOrigin, signFileURL } from '@/lib/file-proxy';
import z from 'zod';

export const dynamic = 'force-dynamic';

// TIDAL mirror of /api/download-music: same Qobuz quality ids in, same signed
// /api/file link out, so the player and download pipeline treat TIDAL like Qobuz.
const downloadParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric'),
    quality: z.enum(['27', '7', '6', '5']).default('27')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, quality } = downloadParamsSchema.parse(params);
        const streamUrl = await getStreamURL(track_id, quality);
        if (!streamUrl) throw new Error('TIDAL returned no downloadable stream for this track.');
        const url = signFileURL(streamUrl, getRequestOrigin(request));
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
