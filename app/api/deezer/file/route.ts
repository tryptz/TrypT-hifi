import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import axios from 'axios';
import z from 'zod';
import { verifyFileURL } from '@/lib/file-proxy';
import { BLOCK_SIZE, DEEZER_FORMATS, DeezerFormat, DeezerTrackFile, decryptStripes, formatExtension, formatMime, resolveTrackFile } from '@/lib/deezer-dl-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Serves a full Deezer track, decrypted, from a signed link made by
// /api/deezer/download-music. HEAD and single byte ranges are supported, like
// /api/file and /api/tidal/atmos-file, so the download pipeline can size the file
// and players (the web player, Tryptify) can seek.
//
// The CDN file is decrypted in 2048-byte blocks, so a range is widened to block
// boundaries upstream, decrypted, then trimmed back to exactly what was asked for.

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const paramsSchema = z.object({
    track_id: z.string().regex(/^\d{1,20}$/, 'ID must be numeric'),
    format: z.enum(DEEZER_FORMATS as [DeezerFormat, ...DeezerFormat[]]),
    exp: z.preprocess((a) => parseInt(a as string), z.number().int().positive()),
    sig: z.string().regex(/^[0-9a-f]{64}$/i, 'Malformed signature')
});

// A player sends a burst of range requests per track; resolving the CDN URL is
// three Deezer calls, so keep it (and the file size) for a few minutes.
type Resolved = DeezerTrackFile & { size: number };
const RESOLVE_TTL_MS = 5 * 60 * 1000;
const resolvedCache: Map<string, { value: Promise<Resolved>; expires: number }> = ((globalThis as any).__deezerFileCache ??= new Map());

function agent() {
    return process.env.SOCKS5_PROXY ? new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY) : undefined;
}

async function resolveWithSize(trackId: string, format: DeezerFormat): Promise<Resolved> {
    const file = await resolveTrackFile(trackId, [format]);
    const proxy = agent();
    // A one-byte range answers with the total size in Content-Range.
    const probe = await axios.get(file.url, {
        headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
        responseType: 'arraybuffer',
        httpAgent: proxy,
        httpsAgent: proxy,
        timeout: 15000
    });
    const size = Number(String(probe.headers['content-range'] || '').split('/')[1] || probe.headers['content-length']);
    if (!Number.isFinite(size) || size <= 0) throw new Error('Deezer CDN did not report the file size.');
    return { ...file, size };
}

function getResolved(trackId: string, format: DeezerFormat, fresh = false): Promise<Resolved> {
    const key = `${trackId}:${format}`;
    const cached = resolvedCache.get(key);
    if (!fresh && cached && cached.expires > Date.now()) return cached.value;
    const value = resolveWithSize(trackId, format);
    resolvedCache.set(key, { value, expires: Date.now() + RESOLVE_TTL_MS });
    value.catch(() => resolvedCache.delete(key));
    return value;
}

function errorResponse(status: number, error: any) {
    return new NextResponse(JSON.stringify({ success: false, error }), { status });
}

async function serve(request: NextRequest, method: 'GET' | 'HEAD') {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    let track_id: string, format: DeezerFormat;
    try {
        ({ track_id, format } = (() => {
            const parsed = paramsSchema.parse(params);
            const verdict = verifyFileURL(`deezer:${parsed.track_id}:${parsed.format}`, parsed.exp, parsed.sig);
            if (verdict !== 'ok') throw Object.assign(new Error(verdict === 'expired' ? 'Link expired, request a new download URL.' : 'Invalid signature'), { status: verdict === 'expired' ? 410 : 403 });
            return parsed;
        })());
    } catch (error: any) {
        if (error instanceof z.ZodError) return errorResponse(400, error.errors);
        return errorResponse(error.status || 400, error.message);
    }

    try {
        for (const fresh of [false, true]) {
            const file = await getResolved(track_id, format, fresh);
            const { size } = file;

            let start = 0;
            let end = size - 1;
            const headers: Record<string, string> = {
                'Content-Type': formatMime(format),
                'Accept-Ranges': 'bytes',
                'Content-Disposition': `attachment; filename="${track_id}.${formatExtension(format)}"`,
                'Cache-Control': 'private, no-store'
            };
            const range = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
            if (range && (range[1] || range[2])) {
                start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
                end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
                if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }
            headers['Content-Length'] = String(end - start + 1);
            const status = headers['Content-Range'] ? 206 : 200;
            if (method === 'HEAD') return new NextResponse(null, { status, headers });

            const alignedStart = start - (start % BLOCK_SIZE);
            const alignedEnd = Math.min(Math.ceil((end + 1) / BLOCK_SIZE) * BLOCK_SIZE, size) - 1;
            const proxy = agent();
            let upstream;
            try {
                upstream = await axios.get(file.url, {
                    headers: { Range: `bytes=${alignedStart}-${alignedEnd}`, 'Accept-Encoding': 'identity' },
                    responseType: 'stream',
                    decompress: false,
                    httpAgent: proxy,
                    httpsAgent: proxy,
                    signal: request.signal,
                    timeout: 15000,
                    validateStatus: (s) => s === 206 || s === 200
                });
            } catch (error: any) {
                error.response?.data?.destroy?.();
                // The cached CDN URL may have expired: resolve a new one once.
                const upstreamStatus = error.response?.status;
                if (!fresh && upstreamStatus >= 400 && upstreamStatus < 500) continue;
                throw error;
            }
            if (upstream.status === 200 && alignedStart > 0) {
                upstream.data.destroy();
                throw new Error('Deezer CDN ignored the byte range.');
            }

            const decrypted = decryptStripes(upstream.data as Readable, file.songId, alignedStart / BLOCK_SIZE);
            let skip = start - alignedStart;
            let remaining = end - start + 1;
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        while (remaining > 0) {
                            const { value, done } = await decrypted.next();
                            if (done) break;
                            let chunk = value;
                            if (skip) {
                                const dropped = Math.min(skip, chunk.length);
                                chunk = chunk.subarray(dropped);
                                skip -= dropped;
                            }
                            if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
                            if (!chunk.length) continue;
                            remaining -= chunk.length;
                            controller.enqueue(new Uint8Array(chunk));
                            return;
                        }
                        controller.close();
                        upstream.data.destroy();
                    } catch (error) {
                        controller.error(error);
                    }
                },
                async cancel() {
                    upstream.data.destroy();
                    await decrypted.return(undefined);
                }
            });
            return new NextResponse(body, { status, headers });
        }
        throw new Error('Deezer CDN refused the file.');
    } catch (error: any) {
        console.error('Deezer file error:', error?.message);
        return errorResponse(502, error?.message || 'Upstream error');
    }
}

export const GET = (request: NextRequest) => serve(request, 'GET');
export const HEAD = (request: NextRequest) => serve(request, 'HEAD');
