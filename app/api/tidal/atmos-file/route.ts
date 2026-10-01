import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { openAtmos } from '@/lib/tidal-atmos-server';
import z from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Serves a TIDAL Dolby Atmos track assembled from its DASH segments (see
// lib/tidal-atmos-server.ts), untouched: the full bed + JOC objects + OAMD.
// HEAD and single-range GETs are supported so the download pipeline can size the
// file first, like it does for /api/file links. A GET from byte 0 while the
// file is still being assembled streams segments as they arrive, so a player
// (Tryptify) starts within a segment or two instead of waiting for the whole file.
const paramsSchema = z.object({
    track_id: z.string().regex(/^\d{1,20}$/, 'ID must be numeric')
});

async function serve(request: NextRequest, method: 'GET' | 'HEAD') {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { track_id } = paramsSchema.parse(params);
        const headers: Record<string, string> = {
            'Content-Type': 'audio/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `attachment; filename="${track_id}.m4a"`,
            'Cache-Control': 'private, no-store'
        };
        const opened = await openAtmos(track_id);
        const rangeHeader = request.headers.get('range');
        const fromStart = !rangeHeader || /^bytes=0-$/.test(rangeHeader);
        if ('build' in opened && method === 'GET' && fromStart) {
            // Size is unknown until every segment is in, so no Content-Length / ranges yet.
            const segments = opened.build.stream();
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const { value, done } = await segments.next();
                        if (done) controller.close();
                        else controller.enqueue(new Uint8Array(value));
                    } catch (error) {
                        controller.error(error);
                    }
                },
                async cancel() {
                    await segments.return(undefined);
                }
            });
            return new NextResponse(body, { status: 200, headers: { ...headers, 'Accept-Ranges': 'none' } });
        }
        const file = 'file' in opened ? opened.file : await opened.build.done;
        const { size } = await fs.promises.stat(file);

        let start = 0;
        let end = size - 1;
        const range = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
        if (range && (range[1] || range[2])) {
            start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
            end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
            headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        }
        headers['Content-Length'] = String(end - start + 1);
        const status = headers['Content-Range'] ? 206 : 200;
        if (method === 'HEAD') return new NextResponse(null, { status, headers });
        const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
        return new NextResponse(stream, { status, headers });
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

export const GET = (request: NextRequest) => serve(request, 'GET');
export const HEAD = (request: NextRequest) => serve(request, 'HEAD');
