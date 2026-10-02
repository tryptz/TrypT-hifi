import { NextRequest, NextResponse } from 'next/server';
import { getDeezerDownloadURL } from '@/lib/deezer-dl-server';
import { getRequestOrigin, signFileURL } from '@/lib/file-proxy';
import z from 'zod';

export const dynamic = 'force-dynamic';

// Deezer mirror of /api/download-music and /api/tidal/download-music: same request
// shape (track_id + Qobuz quality id) and same response ({ success, data: { url } }
// pointing at a signed /api/file link), so the download pipeline and player treat
// every source identically. quality ids map through getDeezerDownloadURL
// (27/6 -> FLAC, 7 -> MP3 320, 5 -> MP3 128), always to the full-length file.
const downloadParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric'),
    quality: z.enum(['27', '7', '6', '5']).default('27')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, quality } = downloadParamsSchema.parse(params);
        const cdnUrl = await getDeezerDownloadURL(track_id, quality);
        if (!cdnUrl) throw new Error('Deezer returned no stream for this track.');
        const url = signFileURL(cdnUrl, getRequestOrigin(request));
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
