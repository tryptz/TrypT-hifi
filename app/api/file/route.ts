import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import axios from 'axios';
import z from 'zod';
import { verifyFileURL } from '@/lib/file-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const fileParamsSchema = z.object({
    url: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/, 'Malformed URL parameter')
        .transform((v) => Buffer.from(v, 'base64url').toString('utf8'))
        .pipe(z.string().url('A valid URL is required')),
    exp: z.preprocess((a) => parseInt(a as string), z.number().int().positive('Expiry must be a positive unix timestamp')),
    sig: z.string().regex(/^[0-9a-f]{64}$/i, 'Malformed signature')
});

const PASS_THROUGH_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

function errorResponse(status: number, error: any) {
    return new NextResponse(JSON.stringify({ success: false, error }), { status });
}

async function proxy(request: NextRequest, method: 'GET' | 'HEAD') {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    let upstream;
    try {
        const { url, exp, sig } = fileParamsSchema.parse(params);
        const verdict = verifyFileURL(url, exp, sig);
        if (verdict === 'invalid') return errorResponse(403, 'Invalid signature');
        if (verdict === 'expired') return errorResponse(410, 'Link expired, request a new download URL.');

        let proxyAgent = undefined;
        if (process.env.SOCKS5_PROXY) {
            proxyAgent = new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
        }
        const range = request.headers.get('range');
        const ifRange = request.headers.get('if-range');
        upstream = await axios.request({
            url,
            method,
            responseType: 'stream',
            decompress: false,
            headers: {
                'Accept-Encoding': 'identity',
                ...(range ? { Range: range } : {}),
                ...(ifRange ? { 'If-Range': ifRange } : {})
            },
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            signal: request.signal,
            validateStatus: (s) => s === 200 || s === 206 || s === 416
        });
    } catch (error: any) {
        error.response?.data?.destroy?.();
        if (error instanceof z.ZodError) return errorResponse(400, error.errors);
        const status = error.response?.status;
        if (status && status >= 400 && status < 500) return errorResponse(410, 'Upstream link expired, request a new download URL.');
        return errorResponse(502, 'Upstream error');
    }

    const headers = new Headers();
    for (const name of PASS_THROUGH_RESPONSE_HEADERS) {
        const value = upstream.headers[name];
        if (value !== undefined) headers.set(name, String(value));
    }
    if (method === 'HEAD') {
        upstream.data?.destroy?.();
        return new NextResponse(null, { status: upstream.status, headers });
    }
    return new NextResponse(Readable.toWeb(upstream.data) as unknown as ReadableStream, { status: upstream.status, headers });
}

export async function GET(request: NextRequest) {
    return proxy(request, 'GET');
}

export async function HEAD(request: NextRequest) {
    return proxy(request, 'HEAD');
}
