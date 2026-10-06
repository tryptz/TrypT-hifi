import { NextRequest, NextResponse } from 'next/server';
import { resolveStream } from '@/lib/tidal-stream-server';
import { describeAtmos } from '@/lib/tidal-atmos-server';
import { getRequestOrigin, signFileURL } from '@/lib/file-proxy';
import z from 'zod';

export const dynamic = 'force-dynamic';

// TIDAL mirror of /api/download-music: same Qobuz quality ids in, a link to one
// whole file out (a signed /api/file link, or /api/tidal/stream-file when TIDAL
// delivers the track as DASH segments), so the player and download pipeline
// treat TIDAL like Qobuz.
// atmos=true instead returns a link to /api/tidal/atmos-file, which serves the
// track's full Dolby Atmos (E-AC-3 JOC) mix untouched, plus a description of that
// stream (codec, bed layout, object count); quality is ignored then.
const downloadParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric'),
    quality: z.enum(['27', '7', '6', '5']).default('27'),
    atmos: z.enum(['true', 'false']).default('false')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id, quality, atmos } = downloadParamsSchema.parse(params);
        if (atmos === 'true') {
            const stream = await describeAtmos(track_id);
            const url = new URL('/api/tidal/atmos-file', getRequestOrigin(request));
            url.searchParams.set('track_id', track_id);
            return new NextResponse(JSON.stringify({ success: true, data: { url: url.toString(), atmos: true, stream } }), { status: 200 });
        }
        const stream = await resolveStream(track_id, quality);
        if (!stream) throw new Error('TIDAL returned no downloadable stream for this track.');
        let url: string;
        if (stream.kind === 'file') url = signFileURL(stream.url, getRequestOrigin(request));
        else {
            // DASH: segments assembled into one file by /api/tidal/stream-file (already building).
            const file = new URL('/api/tidal/stream-file', getRequestOrigin(request));
            file.searchParams.set('track_id', track_id);
            file.searchParams.set('quality', stream.quality);
            url = file.toString();
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
