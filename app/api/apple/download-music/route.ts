import { NextRequest, NextResponse } from 'next/server';
import { buildDownloadManifest } from '@/lib/apple-music-server';
import { getRequestOrigin } from '@/lib/file-proxy';
import z from 'zod';

// crypto/proxy usage: pin the Node.js runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Unlike the Qobuz route (which returns a signed CDN url), Apple hands out no
// decryptable stream url. This route emits a DOWNLOAD JOB MANIFEST instead: the
// contract that the native Tryptify app consumes to fetch, decrypt (FairPlay),
// and render (Dolby Atmos / EC-3 JOC) the track on-device.
const appleDownloadParamsSchema = z.object({
    track_id: z.string().min(1, 'ID is required'), // Apple adamId is a string
    quality: z.enum(['alac', 'hires-lossless', 'atmos', 'aac']).default('alac')
});

export async function GET(request: NextRequest) {
    const country = request.headers.get('Token-Country');
    const userToken = request.headers.get('Music-User-Token') || undefined;
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, quality } = appleDownloadParamsSchema.parse(params);
        const manifest = await buildDownloadManifest(track_id, quality, {
            ...(country ? { country } : {}),
            userToken,
            origin: getRequestOrigin(request)
        });
        return new NextResponse(JSON.stringify({ success: true, data: { manifest } }), { status: 200 });
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
