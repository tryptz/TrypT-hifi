import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { OpenedDash } from './tidal-dash-server';

// Serves a file assembled by lib/tidal-dash-server.ts (/api/tidal/atmos-file,
// /api/tidal/stream-file). HEAD and single-range GETs are supported so the
// download pipeline can size the file first, like it does for /api/file links.
// A GET from byte 0 while the file is still being assembled streams segments as
// they arrive, so a player starts within a segment or two instead of waiting
// for the whole file.
export async function serveDash(
    request: NextRequest,
    method: 'GET' | 'HEAD',
    opened: OpenedDash,
    file: { contentType: string; filename: string }
): Promise<NextResponse> {
    const headers: Record<string, string> = {
        'Content-Type': file.contentType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'private, no-store'
    };
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
    const path = 'file' in opened ? opened.file : await opened.build.done;
    const { size } = await fs.promises.stat(path);

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
    const stream = Readable.toWeb(fs.createReadStream(path, { start, end })) as ReadableStream;
    return new NextResponse(stream, { status, headers });
}

export const dashErrorResponse = (error: any) =>
    new NextResponse(
        JSON.stringify({
            success: false,
            error: error?.errors || error?.message || 'An error occurred parsing the request.'
        }),
        { status: 400 }
    );
