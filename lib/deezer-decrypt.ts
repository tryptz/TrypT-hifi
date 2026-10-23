import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { Blowfish } from './blowfish';
import type { DeezerStreamQuality } from './deezer-dl-server';

// Deezer's file encryption, undone on the server, so a browser can play a
// Deezer song (/api/file with a signed `deezer` id, see lib/file-proxy.ts).
//
// Every full-length file on Deezer's CDN is "striped": cut into 2048-byte
// blocks, and every third one (blocks 0, 3, 6, …) Blowfish-CBC encrypted with
// a fixed IV and a key made from the song id. Each of those blocks is a CBC run
// of its own, starting again from the IV. A short last block is never
// encrypted. Tryptify's Android app undoes this itself (its
// DeezerStripeDecryptor), and tryptify-party's src/deezer.rs is the same, block
// for block; tests/deezer-decrypt.test.ts holds this file to both.

export const DEEZER_BLOCK = 2048;
const IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const SECRET = 'g4el58wc0zvf9na1';

// The key of Deezer song `id`: the md5 of the id (as decimal text) in lowercase
// hex, its two halves and the secret laid over each other.
export function deezerKey(id: string | number): Uint8Array {
    const hex = crypto.createHash('md5').update(String(id)).digest('hex');
    const key = new Uint8Array(16);
    for (let i = 0; i < 16; i++) key[i] = hex.charCodeAt(i) ^ hex.charCodeAt(i + 16) ^ SECRET.charCodeAt(i);
    return key;
}

// Decrypts a striped file as it streams past: feed() it bytes in any sizes and
// it hands back what is ready (whole blocks); finish() hands back the rest. The
// output is exactly as long as the input. `firstBlock` is the index of the block
// the input starts at, for a stream that starts part way into the file (a range
// request fetched from a block boundary).
export class StripeDecryptor {
    private readonly cipher: Blowfish;
    private pending: Buffer = Buffer.alloc(0);
    private index: number;

    constructor(id: string | number, firstBlock = 0) {
        this.cipher = new Blowfish(deezerKey(id));
        this.index = firstBlock;
    }

    feed(chunk: Uint8Array): Buffer {
        // A copy either way: the blocks are decrypted in place.
        const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
        const whole = data.length - (data.length % DEEZER_BLOCK);
        for (let at = 0; at < whole; at += DEEZER_BLOCK) {
            if (this.index % 3 === 0) this.cipher.decryptCbc(data.subarray(at, at + DEEZER_BLOCK), IV);
            this.index++;
        }
        this.pending = data.subarray(whole);
        return data.subarray(0, whole);
    }

    finish(): Buffer {
        const rest = this.pending;
        this.pending = Buffer.alloc(0);
        return rest;
    }
}

export type StripeSlice = {
    // Index of the block the source starts at (its first byte is block-aligned).
    firstBlock?: number;
    // Bytes to drop from the front of the decrypted output.
    skip?: number;
    // Bytes to hand on at most, after skipping; the rest is dropped.
    limit?: number;
};

// A stream that decrypts what is piped into it and hands on the slice asked for.
export function stripeDecryptStream(id: string | number, slice: StripeSlice = {}): Transform {
    const decryptor = new StripeDecryptor(id, slice.firstBlock ?? 0);
    let skip = slice.skip ?? 0;
    let left = slice.limit ?? Infinity;
    const emit = (stream: Transform, out: Buffer) => {
        if (skip > 0) {
            const n = Math.min(skip, out.length);
            out = out.subarray(n);
            skip -= n;
        }
        if (out.length > left) out = out.subarray(0, left);
        left -= out.length;
        if (out.length) stream.push(out);
    };
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            emit(this, decryptor.feed(chunk));
            callback();
        },
        flush(callback) {
            emit(this, decryptor.finish());
            callback();
        }
    });
}

export type ByteRange = { start: number; end?: number };

// The one range of a `Range: bytes=start-` or `bytes=start-end` header. Null
// for anything else (no header, a suffix range `bytes=-n`, several ranges, or
// a malformed one), which the caller answers with the whole file: a server may
// always ignore Range (RFC 9110, 14.2).
export function parseByteRange(header: string | null | undefined): ByteRange | null {
    const match = header?.trim().match(/^bytes\s*=\s*(\d+)\s*-\s*(\d*)$/i);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : undefined;
    if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) return null;
    return { start, end };
}

// What to ask the CDN for, to answer `range` decrypted: whole blocks around
// it, since an encrypted block only decrypts whole. The start goes back to its
// block's first byte; the end, if given, forward to its block's last byte (the
// CDN stops at the end of the file, where a short block is plain anyway).
export function alignedUpstreamRange(range: ByteRange): ByteRange {
    const start = range.start - (range.start % DEEZER_BLOCK);
    const end = range.end === undefined ? undefined : range.end - (range.end % DEEZER_BLOCK) + DEEZER_BLOCK - 1;
    return { start, end };
}

export function formatByteRange(range: ByteRange): string {
    return `bytes=${range.start}-${range.end ?? ''}`;
}

// A response's `Content-Range: bytes start-end/total` (total may be `*`).
export function parseContentRange(header: string | null | undefined): { start: number; end: number; total?: number } | null {
    const match = header?.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return null;
    return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? undefined : Number(match[3]) };
}

// `*/total` of an unsatisfiable range's Content-Range.
export function parseUnsatisfiedRange(header: string | null | undefined): number | undefined {
    const match = header?.trim().match(/^bytes\s+\*\/(\d+)$/i);
    return match ? Number(match[1]) : undefined;
}

// The CDN's own Content-Type when it names an audio type, otherwise the one the
// format implies (it tends to say application/octet-stream).
export function deezerContentType(upstream: string | null | undefined, format: DeezerStreamQuality): string {
    if (upstream && /^audio\//i.test(upstream.trim())) return upstream;
    return format === 'FLAC' ? 'audio/flac' : 'audio/mpeg';
}
