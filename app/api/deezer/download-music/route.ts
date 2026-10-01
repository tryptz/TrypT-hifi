import { NextRequest, NextResponse } from 'next/server';
import { formatExtension, getDownloadFormat } from '@/lib/deezer-dl-server';
import { getRequestOrigin, signRouteURL } from '@/lib/file-proxy';
import z from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Deezer mirror of /api/download-music and /api/tidal/download-music: same Qobuz
// quality ids in, same { success, data: { url } } out, so the player, the download
// pipeline and Tryptify treat Deezer like the other sources. The link points at
// /api/deezer/file, which decrypts the track as it streams. Deezer tops out at
// 16/44.1 FLAC, so '6', '7' and '27' all ask for FLAC; '5' asks for MP3 320. If
// the ARL's plan lacks the format, the next one down is used and `format` says so.
const downloadParamsSchema = z.object({
    track_id: z.string().regex(/^\d{1,20}$/, 'ID must be numeric'),
    quality: z.enum(['27', '7', '6', '5']).default('27')
});

// Long enough for a player to keep seeking through a long track.
const LINK_TTL_SECONDS = 6 * 60 * 60;

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, quality } = downloadParamsSchema.parse(params);
        const format = await getDownloadFormat(track_id, quality);
        const url = signRouteURL('/api/deezer/file', `deezer:${track_id}:${format}`, { track_id, format }, getRequestOrigin(request), LINK_TTL_SECONDS);
        return new NextResponse(JSON.stringify({ success: true, data: { url, format, extension: formatExtension(format) } }), { status: 200 });
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
