// /api/file end to end, against a stand-in for Deezer's CDN on localhost: plain
// links pass the file through untouched, Deezer links decrypt it, ranges
// included. Run with `npm test`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { GET, HEAD } from '../app/api/file/route';
import { DeezerFileSignature, signDeezerFileURL, signFileURL } from '../lib/file-proxy';
import { plainFile, striped } from './striped';

process.env.FILE_PROXY_SECRET = 'test-secret';
// The CDN stand-in is on localhost; keep axios off any configured proxy.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'SOCKS5_PROXY']) delete process.env[name];

const ID = '3135553';
const FLAC: DeezerFileSignature = { id: ID, format: 'FLAC' };
const plain = plainFile(2048 * 12 + 777);
const served = striped(ID, plain);
const ORIGIN = 'http://trypt-hifi.test';

let server: http.Server;
let cdn = '';
// The Range header of each request the CDN saw.
const seen: (string | undefined)[] = [];

// Serves `served` with single-range support, the way a CDN does; `?norange`
// ignores Range, like a server that cannot do it.
before(async () => {
    server = http.createServer((req, res) => {
        const range = req.headers.range;
        seen.push(range);
        const head = { 'Content-Type': 'application/octet-stream', ETag: '"abc"', 'Accept-Ranges': 'bytes' };
        const body = (data: Buffer) => (req.method === 'HEAD' ? res.end() : res.end(data));
        const match = range?.match(/^bytes=(\d+)-(\d*)$/);
        if (!match || req.url?.includes('norange')) {
            res.writeHead(200, { ...head, 'Content-Length': served.length });
            return body(served);
        }
        const start = Number(match[1]);
        const end = Math.min(match[2] ? Number(match[2]) : served.length - 1, served.length - 1);
        if (start >= served.length) {
            res.writeHead(416, { 'Content-Range': `bytes */${served.length}` });
            return res.end();
        }
        res.writeHead(206, { ...head, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${served.length}` });
        body(served.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cdn = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.flac`;
});

after(() => server.close());

async function fetchLink(link: string, range?: string, method: 'GET' | 'HEAD' = 'GET') {
    const request = new NextRequest(link, { method, headers: range ? { range } : {} });
    const response = await (method === 'GET' ? GET(request) : HEAD(request));
    const body = method === 'GET' && response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
    return { response, body, upstreamRange: seen[seen.length - 1] };
}

test('a plain link still passes the file through as it is', async () => {
    const { response, body } = await fetchLink(signFileURL(cdn, ORIGIN));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(body, served);

    const ranged = await fetchLink(signFileURL(cdn, ORIGIN), 'bytes=5000-5999');
    assert.equal(ranged.response.status, 206);
    assert.equal(ranged.upstreamRange, 'bytes=5000-5999');
    assert.equal(ranged.response.headers.get('content-range'), `bytes 5000-5999/${served.length}`);
    assert.deepEqual(ranged.body, served.subarray(5000, 6000));
});

test('a plain link is signed as before, a Deezer link over more', () => {
    const hmac = (text: string) => crypto.createHmac('sha256', 'test-secret').update(text).digest('hex');
    const link = new URL(signFileURL(cdn, ORIGIN));
    assert.deepEqual(Array.from(link.searchParams.keys()), ['url', 'exp', 'sig']);
    assert.equal(link.searchParams.get('sig'), hmac(`${cdn}\n${link.searchParams.get('exp')}`));

    const deezer = new URL(signDeezerFileURL(cdn, ORIGIN, FLAC));
    assert.deepEqual(Array.from(deezer.searchParams.keys()), ['url', 'exp', 'deezer', 'format', 'sig']);
    assert.equal(deezer.searchParams.get('sig'), hmac(`${cdn}\n${deezer.searchParams.get('exp')}\ndeezer:${ID}:FLAC`));
});

test('a Deezer link serves the whole file decrypted', async () => {
    const link = signDeezerFileURL(cdn, ORIGIN, FLAC);
    const { response, body, upstreamRange } = await fetchLink(link);
    assert.equal(response.status, 200);
    assert.equal(upstreamRange, undefined);
    assert.equal(response.headers.get('content-type'), 'audio/flac');
    assert.equal(response.headers.get('content-length'), String(plain.length));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('etag'), '"abc"');
    assert.deepEqual(body, plain);
});

test('a Deezer link answers ranges decrypted, fetched from whole blocks', async () => {
    const link = signDeezerFileURL(cdn, ORIGIN, FLAC);
    const total = plain.length;
    const cases: [string, number, number, string][] = [
        ['bytes=0-', 0, total - 1, 'bytes=0-'],
        ['bytes=0-0', 0, 0, 'bytes=0-2047'],
        ['bytes=5000-', 5000, total - 1, 'bytes=4096-'],
        ['bytes=5000-9000', 5000, 9000, 'bytes=4096-10239'],
        ['bytes=6144-6144', 6144, 6144, 'bytes=6144-8191'],
        [`bytes=${total - 10}-`, total - 10, total - 1, `bytes=${total - 777}-`],
        [`bytes=100-${total + 5000}`, 100, total - 1, `bytes=0-${total + 5000 - ((total + 5000) % 2048) + 2047}`]
    ];
    for (const [range, start, end, upstream] of cases) {
        const { response, body, upstreamRange } = await fetchLink(link, range);
        assert.equal(response.status, 206, range);
        assert.equal(upstreamRange, upstream, `${range} asks the CDN for`);
        assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${total}`, range);
        assert.equal(response.headers.get('content-length'), String(end - start + 1), range);
        assert.deepEqual(body, plain.subarray(start, end + 1), range);
    }
});

test('a range past the end is unsatisfiable', async () => {
    const link = signDeezerFileURL(cdn, ORIGIN, FLAC);
    // In the last (partial) block: the CDN answers 206 for the block, we 416.
    const inLastBlock = await fetchLink(link, `bytes=${plain.length + 5}-`);
    assert.equal(inLastBlock.response.status, 416);
    assert.equal(inLastBlock.response.headers.get('content-range'), `bytes */${plain.length}`);
    // Past it: the CDN answers 416 itself.
    const beyond = await fetchLink(link, `bytes=${plain.length + 5000}-`);
    assert.equal(beyond.response.status, 416);
    assert.equal(beyond.response.headers.get('content-range'), `bytes */${plain.length}`);
});

test('a suffix range gets the whole file, decrypted', async () => {
    const { response, body, upstreamRange } = await fetchLink(signDeezerFileURL(cdn, ORIGIN, FLAC), 'bytes=-500');
    assert.equal(response.status, 200);
    assert.equal(upstreamRange, undefined);
    assert.deepEqual(body, plain);
});

test('a CDN that ignores Range still gets the whole file decrypted', async () => {
    const { response, body } = await fetchLink(signDeezerFileURL(cdn + '?norange', ORIGIN, FLAC), 'bytes=5000-');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(plain.length));
    assert.deepEqual(body, plain);
});

test('HEAD gives the same headers and no body', async () => {
    const { response } = await fetchLink(signDeezerFileURL(cdn, ORIGIN, { id: ID, format: 'MP3_320' }), 'bytes=5000-9000', 'HEAD');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('content-range'), `bytes 5000-9000/${plain.length}`);
    assert.equal(response.headers.get('content-length'), '4001');
});

test('the id and format cannot be changed, dropped or added', async () => {
    const link = new URL(signDeezerFileURL(cdn, ORIGIN, FLAC));
    const changed = new URL(link);
    changed.searchParams.set('deezer', '42');
    assert.equal((await fetchLink(changed.toString())).response.status, 403);

    const reformatted = new URL(link);
    reformatted.searchParams.set('format', 'MP3_128');
    assert.equal((await fetchLink(reformatted.toString())).response.status, 403);

    const dropped = new URL(link);
    dropped.searchParams.delete('deezer');
    dropped.searchParams.delete('format');
    assert.equal((await fetchLink(dropped.toString())).response.status, 403);

    const half = new URL(link);
    half.searchParams.delete('format');
    assert.equal((await fetchLink(half.toString())).response.status, 400);

    const added = new URL(signFileURL(cdn, ORIGIN));
    added.searchParams.set('deezer', ID);
    added.searchParams.set('format', 'FLAC');
    assert.equal((await fetchLink(added.toString())).response.status, 403);
});
