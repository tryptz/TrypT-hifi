import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import { cacheFilePath, ensureCacheDir, sweepExpired, ttlSeconds, verifyStreamSig, verifyUploadToken } from '@/lib/apple-file-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(status: number, error: string) {
    return new NextResponse(JSON.stringify({ success: false, error }), { status });
}

// Home wrapper/downloader uploads the decrypted file here (X-Upload-Token auth).
export async function PUT(request: NextRequest, { params }: { params: Promise<{ adamId: string }> }) {
    const { adamId } = await params;
    if (!verifyUploadToken(request.headers.get('x-upload-token'))) return err(401, 'Unauthorized');
    let dest: string;
    try {
        dest = cacheFilePath(adamId);
    } catch {
        return err(400, 'Invalid adamId');
    }
    if (!request.body) return err(400, 'Empty body');

    await ensureCacheDir();
    await sweepExpired();
    const tmp = `${dest}.part`;
    try {
        await pipeline(Readable.fromWeb(request.body as unknown as import('node:stream/web').ReadableStream), fs.createWriteStream(tmp));
        await fs.promises.rename(tmp, dest); // atomic swap so GET never sees a partial file
    } catch {
        await fs.promises.unlink(tmp).catch(() => {});
        return err(500, 'Failed to store file');
    }
    return NextResponse.json({ success: true, data: { adamId, expiresInSeconds: ttlSeconds() } });
}

async function serve(request: NextRequest, adamId: string, method: 'GET' | 'HEAD') {
    const sp = new URL(request.url).searchParams;
    const exp = Number(sp.get('exp'));
    const sig = sp.get('sig') || '';
    if (!Number.isFinite(exp)) return err(400, 'Missing or malformed exp');
    const verdict = verifyStreamSig(adamId, exp, sig);
    if (verdict === 'invalid') return err(403, 'Invalid signature');
    if (verdict === 'expired') return err(410, 'Link expired, request a new one');

    let file: string;
    try {
        file = cacheFilePath(adamId);
    } catch {
        return err(400, 'Invalid adamId');
    }

    await sweepExpired();
    let st: fs.Stats;
    try {
        st = await fs.promises.stat(file);
    } catch {
        return err(404, 'Not available yet — the file has not been uploaded, or its 10-minute window has passed.');
    }
    // TTL guard, in case the sweep above missed it.
    if (Date.now() - st.mtimeMs > ttlSeconds() * 1000) {
        await fs.promises.unlink(file).catch(() => {});
        return err(410, 'Expired');
    }

    const total = st.size;
    const headers = new Headers({
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename="${adamId}.m4a"`
    });

    let status = 200;
    let start = 0;
    let end = total - 1;
    const range = request.headers.get('range');
    if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] || m[2])) {
            if (m[1]) start = parseInt(m[1], 10);
            if (m[2]) end = parseInt(m[2], 10);
            if (Number.isNaN(start)) start = 0;
            if (Number.isNaN(end) || end >= total) end = total - 1;
            if (start > end || start >= total) {
                return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
            }
            status = 206;
            headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
        }
    }
    headers.set('Content-Length', String(end - start + 1));

    if (method === 'HEAD') return new NextResponse(null, { status, headers });
    const node = fs.createReadStream(file, { start, end });
    return new NextResponse(Readable.toWeb(node) as unknown as ReadableStream, { status, headers });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ adamId: string }> }) {
    const { adamId } = await params;
    return serve(request, adamId, 'GET');
}

export async function HEAD(request: NextRequest, { params }: { params: Promise<{ adamId: string }> }) {
    const { adamId } = await params;
    return serve(request, adamId, 'HEAD');
}
