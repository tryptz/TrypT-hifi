// The AI-generated tag on Deezer results: which items annotateDeezerAI marks,
// from Deezer's verdicts (seeded here, so no network). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateDeezerAI } from '../lib/deezer-ai-server';
import { isDeezerAI } from '../lib/deezer';

// Deezer's verdicts, in the module's own cache (made when it was imported).
const flags: Map<string, { ai: boolean; at: number }> = (globalThis as any).__deezerAICache.flags;
flags.set('774152711', { ai: true, at: Date.now() });
flags.set('6575789', { ai: false, at: Date.now() });

const album = (id: number) => ({ qobuz_id: id, id: String(id), title: `Album ${id}`, deezer: { id, link: null } });

test('flagged albums, and tracks on them, are tagged; the rest are not', async () => {
    const results = {
        albums: { items: [album(774152711), album(6575789)] },
        tracks: { items: [{ id: 1, deezer: { id: 1, link: null }, album: album(774152711) }] },
        artists: { items: [{ id: 9, name: 'Someone', deezer: { id: 9, link: null } }] }
    };
    await annotateDeezerAI(results);
    assert.equal(isDeezerAI(results.albums.items[0]), true);
    assert.equal(isDeezerAI(results.albums.items[1]), false);
    assert.equal(isDeezerAI(results.tracks.items[0]), true);
    assert.equal(isDeezerAI(results.artists.items[0]), false);
});

test('items from other sources are never tagged', () => {
    assert.equal(isDeezerAI({ id: '1', title: 'Qobuz album' }), false);
    assert.equal(isDeezerAI(null), false);
});
