// Which Deezer formats a download asks for, best first. Deezer serves the first
// of them a track has, so the list is what makes hi-res fall back to FLAC.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeezerStreamQuality, deezerFormatLadder, deezerQualityFormat } from '../lib/deezer-dl-server';

const hifi = { formats: ['FLAC_24', 'FLAC', 'MP3_320', 'MP3_128'] as DeezerStreamQuality[] };
const premium = { formats: ['MP3_320', 'MP3_128'] as DeezerStreamQuality[] };

test('hi-res asks for FLAC_24, then FLAC, then MP3', () => {
    assert.deepEqual(deezerFormatLadder(hifi, 'FLAC_24'), ['FLAC_24', 'FLAC', 'MP3_320', 'MP3_128']);
});

test('16-bit never asks for FLAC_24', () => {
    assert.deepEqual(deezerFormatLadder(hifi, 'FLAC'), ['FLAC', 'MP3_320', 'MP3_128']);
});

test('an account without HiFi only asks for what it has', () => {
    assert.deepEqual(deezerFormatLadder(premium, 'FLAC_24'), ['MP3_320', 'MP3_128']);
    assert.deepEqual(deezerFormatLadder({ formats: [] }, 'FLAC_24'), ['MP3_128']);
});

test('a format asked for by name starts the list there', () => {
    assert.equal(deezerQualityFormat('MP3_320'), 'MP3_320');
    assert.deepEqual(deezerFormatLadder(hifi, deezerQualityFormat('MP3_320')), ['MP3_320', 'MP3_128']);
    assert.deepEqual(deezerFormatLadder(hifi, deezerQualityFormat('FLAC_24')), ['FLAC_24', 'FLAC', 'MP3_320', 'MP3_128']);
});

test('both 24-bit settings mean hi-res, 16-bit means FLAC', () => {
    assert.equal(deezerQualityFormat('27'), 'FLAC_24');
    assert.equal(deezerQualityFormat('7'), 'FLAC_24');
    assert.equal(deezerQualityFormat('6'), 'FLAC');
    assert.equal(deezerQualityFormat('5'), 'MP3_128');
    assert.equal(deezerQualityFormat('MP3_320'), 'MP3_320');
});
