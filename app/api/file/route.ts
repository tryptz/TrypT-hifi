import { NextRequest, NextResponse } from 'next/server';
import { Readable, pipeline } from 'node:stream';
import axios, { AxiosResponse } from 'axios';
import z from 'zod';
import { DeezerFileSignature, verifyFileURL } from '@/lib/file-proxy';
import {
    ByteRange,
    DEEZER_BLOCK,
    StripeSlice,
    alignedUpstreamRange,
    deezerContentType,
    formatByteRange,
    parseByteRange,
    parseContentRange,
    parseUnsatisfiedRange,
    stripeDecryptStream
} from '@/lib/deezer-decrypt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let SocksProxyAgent: any;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

const fileParamsSchema = z
    .object({
        url: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/, 'Malformed URL parameter')
            .transform((v) => Buffer.from(v, 'base64url').toString('utf8'))
            .pipe(z.string().url('A valid URL is required')),
        exp: z.preprocess((a) => parseInt(a as string), z.number().int().positive('Expiry must be a positive unix timestamp')),
        sig: z.string().regex(/^[0-9a-f]{64}$/i, 'Malformed signature'),
        // A striped Deezer file to decrypt on the way (signDeezerFileURL): the
        // song's id and the file's format, both covered by the signature.
        deezer: z.string().regex(/^-?\d+$/, 'Deezer ID must be numeric').optional(),
        format: z.enum(['FLAC', 'MP3_320', 'MP3_128']).optional()
    })
    .refine((p) => (p.deezer === undefined) === (p.format === undefined), 'deezer and format go together');

const PASS_THROUGH_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

function errorResponse(status: number, error: any) {
    return new NextResponse(JSON.stringify({ success: false, error }), { status });
}

function upstreamAgent() {
    return process.env.SOCKS5_PROXY ? new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY) : undefined;
}

async function proxy(request: NextRequest, method: 'GET' | 'HEAD') {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    let upstream;
    let deezer: DeezerFileSignature | undefined;
    // The range asked for, when a Deezer file is decrypted (the CDN is asked for
    // whole blocks around it instead).
    let wanted: ByteRange | null = null;
    try {
        const { url, exp, sig, deezer: id, format } = fileParamsSchema.parse(params);
        deezer = id && format ? { id, format } : undefined;
        const verdict = verifyFileURL(url, exp, sig, deezer);
        if (verdict === 'invalid') return errorResponse(403, 'Invalid signature');
        if (verdict === 'expired') return errorResponse(410, 'Link expired, request a new download URL.');

        const proxyAgent = upstreamAgent();
        let range = request.headers.get('range');
        if (deezer) {
            // A range the decryptor cannot start from as given (a suffix, several
            // ranges) is dropped: the whole file, with 200, answers it as well.
            wanted = parseByteRange(range);
            range = wanted ? formatByteRange(alignedUpstreamRange(wanted)) : null;
        }
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

    if (deezer) return decryptedResponse(upstream, method, deezer, wanted);

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

// A striped Deezer file, decrypted on the way. The cipher keeps every byte where
// it was, so lengths and offsets are the file's own; a range is fetched from its
// block's first byte, decrypted, then cut back to what was asked.
function decryptedResponse(upstream: AxiosResponse, method: 'GET' | 'HEAD', deezer: DeezerFileSignature, wanted: ByteRange | null) {
    const header = (name: string) => {
        const value = upstream.headers[name];
        return value === undefined || value === null ? undefined : String(value);
    };
    const headers = new Headers();
    headers.set('content-type', deezerContentType(header('content-type'), deezer.format));
    headers.set('accept-ranges', 'bytes');
    for (const name of ['etag', 'last-modified']) {
        const value = header(name);
        if (value !== undefined) headers.set(name, value);
    }
    const unsatisfiable = (total: number | undefined) => {
        upstream.data?.destroy?.();
        if (total !== undefined) headers.set('content-range', `bytes */${total}`);
        return new NextResponse(null, { status: 416, headers });
    };

    let slice: StripeSlice = {};
    let status = 200;
    if (upstream.status === 416) return unsatisfiable(parseUnsatisfiedRange(header('content-range')));
    if (upstream.status === 206) {
        const got = parseContentRange(header('content-range'));
        if (!got || got.start % DEEZER_BLOCK !== 0 || (wanted && got.start > wanted.start)) {
            upstream.data?.destroy?.();
            return errorResponse(502, 'Upstream sent a range that cannot be decrypted.');
        }
        const start = wanted ? wanted.start : got.start;
        if (start > got.end) return unsatisfiable(got.total);
        const end = Math.min(wanted?.end ?? got.end, got.end);
        slice = { firstBlock: got.start / DEEZER_BLOCK, skip: start - got.start, limit: end - start + 1 };
        status = 206;
        headers.set('content-range', `bytes ${start}-${end}/${got.total ?? '*'}`);
        headers.set('content-length', String(end - start + 1));
    } else {
        // The whole file: the CDN was asked for no range, or ignored it.
        const length = header('content-length');
        if (length !== undefined) headers.set('content-length', length);
    }

    if (method === 'HEAD') {
        upstream.data?.destroy?.();
        return new NextResponse(null, { status, headers });
    }
    const source = upstream.data as Readable;
    const body = pipeline(source, stripeDecryptStream(deezer.id, slice), () => {});
    return new NextResponse(Readable.toWeb(body) as unknown as ReadableStream, { status, headers });
}

export async function GET(request: NextRequest) {
    return proxy(request, 'GET');
}

export async function HEAD(request: NextRequest) {
    return proxy(request, 'HEAD');
}
