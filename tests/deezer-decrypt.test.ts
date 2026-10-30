// lib/deezer-decrypt.ts, held to tryptify-party's src/deezer.rs (its tests,
// ported) and to openssl. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable, Writable, pipeline } from 'node:stream';
import {
    DEEZER_BLOCK as BLOCK,
    StripeDecryptor,
    StripeSlice,
    alignedUpstreamRange,
    deezerContentType,
    deezerKey,
    parseByteRange,
    parseContentRange,
    stripeDecryptStream
} from '../lib/deezer-decrypt';
import { plainFile, striped } from './striped';

function decryptInPieces(id: number, served: Uint8Array, size: number, firstBlock = 0): Buffer {
    const decryptor = new StripeDecryptor(id, firstBlock);
    const parts: Buffer[] = [];
    for (let at = 0; at < served.length; at += size) parts.push(decryptor.feed(served.subarray(at, at + size)));
    parts.push(decryptor.finish());
    return Buffer.concat(parts);
}

test('a real Deezer file opens as FLAC', () => {
    // The first eight bytes Deezer's CDN served of song 3135553 (Daft Punk,
    // One More Time), a FLAC file. CBC's first block needs only these and the IV.
    const block = Buffer.alloc(BLOCK);
    block.set([0x04, 0xb9, 0xdc, 0x61, 0x37, 0x2f, 0x57, 0x09]);
    const out = new StripeDecryptor(3135553).feed(block);
    assert.equal(out.subarray(0, 4).toString('latin1'), 'fLaC');
});

test('every third block is decrypted and the rest pass as they are', () => {
    const plain = plainFile(BLOCK * 7 + 100);
    const served = striped(42, plain);
    assert.notDeepEqual(served.subarray(0, BLOCK), plain.subarray(0, BLOCK));
    assert.deepEqual(served.subarray(BLOCK, BLOCK * 3), plain.subarray(BLOCK, BLOCK * 3));
    assert.notDeepEqual(served.subarray(BLOCK * 3, BLOCK * 4), plain.subarray(BLOCK * 3, BLOCK * 4));
    // The short last block is never encrypted.
    assert.deepEqual(served.subarray(BLOCK * 7), plain.subarray(BLOCK * 7));
    for (const size of [1, 7, 777, BLOCK - 1, BLOCK, BLOCK + 1, 10_000, served.length]) {
        assert.deepEqual(decryptInPieces(42, served, size), plain, `fed ${size} at a time`);
    }
});

test('a short last block of an encrypted index stays as it is', () => {
    // 3 whole blocks then 1000 bytes: block 3 would be encrypted, but is short.
    const plain = plainFile(BLOCK * 3 + 1000);
    const served = striped(7, plain);
    assert.deepEqual(served.subarray(BLOCK * 3), plain.subarray(BLOCK * 3));
    assert.deepEqual(decryptInPieces(7, served, 333), plain);
});

test('a stream that starts at a later block decrypts from there', () => {
    const plain = plainFile(BLOCK * 10 + 5);
    const served = striped(42, plain);
    for (const first of [1, 2, 3, 4, 9, 10]) {
        const out = decryptInPieces(42, served.subarray(first * BLOCK), 500, first);
        assert.deepEqual(out, plain.subarray(first * BLOCK), `from block ${first}`);
    }
});

// The key and the CBC run, against openssl's own Blowfish, where it has one.
const openssl = (args: string[], input: Uint8Array) => spawnSync('openssl', [...args, '-provider', 'legacy', '-provider', 'default'], { input: Buffer.from(input) });
const hasOpenSSLBlowfish = openssl(['enc', '-bf-ecb', '-nopad', '-K', '00'.repeat(16)], new Uint8Array(8)).status === 0;

test("a block openssl encrypts with the song's key decrypts", { skip: !hasOpenSSLBlowfish && 'openssl has no legacy Blowfish here' }, () => {
    const id = 3135553;
    const plain = plainFile(BLOCK * 2);
    const run = openssl(['enc', '-bf-cbc', '-nopad', '-K', Buffer.from(deezerKey(id)).toString('hex'), '-iv', '0001020304050607'], plain.subarray(0, BLOCK));
    assert.equal(run.status, 0);
    const served = Buffer.concat([run.stdout, plain.subarray(BLOCK)]);
    assert.deepEqual(served, striped(id, plain));
    assert.deepEqual(decryptInPieces(id, served, 1000), plain);
});

function collect(source: Readable, transform: NodeJS.ReadWriteStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const parts: Buffer[] = [];
        const sink = new Writable({
            write(chunk, _encoding, callback) {
                parts.push(chunk);
                callback();
            }
        });
        pipeline(source, transform, sink, (error) => (error ? reject(error) : resolve(Buffer.concat(parts))));
    });
}

function chunked(data: Buffer, size: number): Readable {
    const pieces: Buffer[] = [];
    for (let at = 0; at < data.length; at += size) pieces.push(data.subarray(at, at + size));
    return Readable.from(pieces);
}

test('the stream slices a range out of block-aligned input', async () => {
    const plain = plainFile(BLOCK * 9 + 321);
    const served = striped(99, plain);
    const cases: [number, number | undefined][] = [
        [0, undefined],
        [0, 0],
        [1, 2],
        [2047, 2048],
        [2048, 6143],
        [5000, 9000],
        [6144, undefined],
        [BLOCK * 9 + 300, undefined],
        [100, BLOCK * 9 + 320]
    ];
    for (const [start, end] of cases) {
        const aligned = alignedUpstreamRange({ start, end });
        const upstream = served.subarray(aligned.start, aligned.end === undefined ? undefined : aligned.end + 1);
        const last = Math.min(end ?? plain.length - 1, plain.length - 1);
        const slice: StripeSlice = { firstBlock: aligned.start / BLOCK, skip: start - aligned.start, limit: last - start + 1 };
        const out = await collect(chunked(upstream, 1500), stripeDecryptStream(99, slice));
        assert.deepEqual(out, plain.subarray(start, last + 1), `bytes=${start}-${end ?? ''}`);
    }
});

test('ranges are aligned to whole blocks', () => {
    assert.deepEqual(alignedUpstreamRange({ start: 0 }), { start: 0, end: undefined });
    assert.deepEqual(alignedUpstreamRange({ start: 5000, end: 9000 }), { start: 4096, end: 10239 });
    assert.deepEqual(alignedUpstreamRange({ start: 4096, end: 4096 }), { start: 4096, end: 6143 });
    assert.deepEqual(alignedUpstreamRange({ start: 2047, end: 2047 }), { start: 0, end: 2047 });
});

test('Range and Content-Range headers', () => {
    assert.deepEqual(parseByteRange('bytes=0-'), { start: 0, end: undefined });
    assert.deepEqual(parseByteRange('bytes=100-200'), { start: 100, end: 200 });
    assert.deepEqual(parseByteRange('BYTES = 5 - 5'), { start: 5, end: 5 });
    assert.equal(parseByteRange(null), null);
    assert.equal(parseByteRange('bytes=-500'), null);
    assert.equal(parseByteRange('bytes=0-1,5-6'), null);
    assert.equal(parseByteRange('bytes=9-3'), null);
    assert.equal(parseByteRange('items=0-1'), null);
    assert.deepEqual(parseContentRange('bytes 4096-10239/30000'), { start: 4096, end: 10239, total: 30000 });
    assert.deepEqual(parseContentRange('bytes 0-9/*'), { start: 0, end: 9, total: undefined });
    assert.equal(parseContentRange('bytes */30000'), null);
});

test('Content-Type from the CDN when it names audio, else from the format', () => {
    assert.equal(deezerContentType('application/octet-stream', 'FLAC'), 'audio/flac');
    assert.equal(deezerContentType('application/octet-stream', 'FLAC_24'), 'audio/flac');
    assert.equal(deezerContentType(undefined, 'MP3_320'), 'audio/mpeg');
    assert.equal(deezerContentType(null, 'MP3_128'), 'audio/mpeg');
    assert.equal(deezerContentType('audio/x-flac', 'FLAC'), 'audio/x-flac');
});
