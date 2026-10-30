// Shared links (lib/share-server.ts): their shape, their signature, and the
// ids the open preview routes accept. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShareTarget, shareSignature, shareURL, verifyShareSignature } from '../lib/share-server';

process.env.FILE_PROXY_SECRET = 'test-secret';

test('a track link names the album and the track, and is signed', () => {
    const url = new URL(shareURL({ source: 'deezer', album: '6575789', track: '67238728' }));
    assert.equal(url.origin, 'https://tryptify.com');
    assert.equal(url.pathname, '/listen/deezer/album/6575789/track/67238728');
    assert.equal(url.searchParams.get('s'), shareSignature({ source: 'deezer', album: '6575789', track: '67238728' }));
});

test('an album link has no track', () => {
    assert.equal(new URL(shareURL({ source: 'qobuz', album: 'abc123xyz' })).pathname, '/listen/qobuz/album/abc123xyz');
});

test('the signature covers the source, the album and the track', () => {
    const target = { source: 'deezer' as const, album: '6575789', track: '67238728' };
    const s = shareSignature(target);
    assert.equal(verifyShareSignature(target, s), true);
    assert.equal(verifyShareSignature({ ...target, track: '1' }, s), false);
    assert.equal(verifyShareSignature({ ...target, track: undefined }, s), false);
    assert.equal(verifyShareSignature({ ...target, source: 'tidal' }, s), false);
    assert.equal(verifyShareSignature(target, null), false);
    assert.equal(verifyShareSignature(target, s.slice(1)), false);
});

test('only known sources and well-formed ids are accepted', () => {
    const parse = (q: string) => parseShareTarget(new URLSearchParams(q));
    assert.deepEqual(parse('source=apple&album=1440857781&track=1440857789'), { source: 'apple', album: '1440857781', track: '1440857789' });
    assert.deepEqual(parse('source=qobuz&album=xw5rk3bkfxjfb'), { source: 'qobuz', album: 'xw5rk3bkfxjfb', track: undefined });
    assert.throws(() => parse('source=spotify&album=1'));
    assert.throws(() => parse('source=deezer&album=../etc'));
    assert.throws(() => parse('source=deezer&album=1&track=abc'));
    assert.throws(() => parse('source=deezer'));
});
