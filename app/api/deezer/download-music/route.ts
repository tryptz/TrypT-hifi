import { NextRequest, NextResponse } from 'next/server';
import { getDeezerDownloadFile, getDeezerDownloadURL } from '@/lib/deezer-dl-server';
import { getRequestOrigin, signDeezerFileURL, signFileURL } from '@/lib/file-proxy';
import z from 'zod';

export const dynamic = 'force-dynamic';

// Deezer mirror of /api/download-music and /api/tidal/download-music: same request
// shape (track_id + Qobuz quality id) and same response ({ success, data: { url } }
// pointing at a signed /api/file link), so the download pipeline and player treat
// every source identically. quality ids map through getDeezerDownloadURL
// (27/7 -> hi-res FLAC_24, 6 -> FLAC, 5 -> MP3 128), always to the full-length file;
// a Deezer format's own name (FLAC_24, FLAC, MP3_320, MP3_128) is taken as well,
// the only way to ask for MP3 320.
// A track with no hi-res master falls back to FLAC, and the link names the
// format Deezer actually served.
//
// The file is Deezer's own, still striped (lib/deezer-decrypt.ts), which
// Tryptify's app decrypts itself. A browser cannot, so `decrypted=1` asks for a
// link /api/file decrypts on the way instead; the response keeps its shape.
const downloadParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric'),
    // The Qobuz quality ids, or a Deezer format by name (MP3_320 has no id).
    quality: z.enum(['27', '7', '6', '5', 'FLAC_24', 'FLAC', 'MP3_320', 'MP3_128']).default('27'),
    decrypted: z.enum(['0', '1', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, quality, decrypted } = downloadParamsSchema.parse(params);
        let url: string;
        if (decrypted) {
            const file = await getDeezerDownloadFile(track_id, quality);
            url = signDeezerFileURL(file.url, getRequestOrigin(request), { id: file.id, format: file.format });
        } else {
            const cdnUrl = await getDeezerDownloadURL(track_id, quality);
            if (!cdnUrl) throw new Error('Deezer returned no stream for this track.');
            url = signFileURL(cdnUrl, getRequestOrigin(request));
        }
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
