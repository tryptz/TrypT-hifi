import axios from 'axios';
import { getDeezerAxiosConfig } from './deezer-dl-server';

// Server only. Deezer's own AI-music detector, on our Deezer results.
//
// Since June 2025 Deezer flags albums with tracks it detected as made with
// generative AI (Suno, Udio, ...) and shows "AI-generated content" on their
// page. The public API (api.deezer.com) does not say so; the web player reads
// it from its GraphQL API, pipe.deezer.com, as Album.hasIdentifiedAIContent.
// Pipe wants a short-lived JWT, which auth.deezer.com hands out for the ARL
// (there is no anonymous one), so without DEEZER_ARL nothing is tagged.
//
// annotateDeezerAI() walks normalized results and sets `deezer.ai` on every
// album Deezer flagged; a track's own tag is its album's. It never throws: a
// missing tag must not cost a search.

const UA = 'Mozilla/5.0 (X11; Linux i686; rv:135.0) Gecko/20100101 Firefox/135.0';
// The JWT lives 6 minutes; renew a minute early.
const JWT_TTL_MS = 5 * 60 * 1000;
// Deezer's verdict on an album rarely changes.
const FLAG_TTL_MS = 6 * 60 * 60 * 1000;
// Albums asked about per GraphQL request (as aliases of one query).
const BATCH = 50;

type AICache = { jwt: string | null; jwtAt: number; flags: Map<string, { ai: boolean; at: number }> };
// On globalThis: every route bundle gets its own copy of this module.
const cache: AICache = ((globalThis as any).__deezerAICache ??= { jwt: null, jwtAt: 0, flags: new Map() });

async function pipeToken(): Promise<string> {
    if (cache.jwt && Date.now() - cache.jwtAt < JWT_TTL_MS) return cache.jwt;
    const response = await axios.post<{ jwt?: string }>(
        'https://auth.deezer.com/login/arl?jo=p&rto=c&i=c',
        null,
        getDeezerAxiosConfig({ timeout: 10000, headers: { 'User-Agent': UA } })
    );
    if (!response.data?.jwt) throw new Error('Deezer: no pipe token for this ARL');
    cache.jwt = response.data.jwt;
    cache.jwtAt = Date.now();
    return cache.jwt;
}

// Which of `ids` Deezer flagged as AI-generated. Unknown albums come back false.
export async function getDeezerAIFlags(ids: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    const now = Date.now();
    const missing: string[] = [];
    for (const id of Array.from(new Set(ids.filter((id) => /^[1-9]\d*$/.test(id))))) {
        const hit = cache.flags.get(id);
        if (hit && now - hit.at < FLAG_TTL_MS) result.set(id, hit.ai);
        else missing.push(id);
    }
    if (!missing.length || !process.env.DEEZER_ARL) return result;

    const jwt = await pipeToken();
    for (let at = 0; at < missing.length; at += BATCH) {
        const batch = missing.slice(at, at + BATCH);
        const query = `query AlbumsAI { ${batch.map((id, i) => `a${i}: album(albumId: "${id}") { hasIdentifiedAIContent }`).join(' ')} }`;
        const response = await axios.post<{ data?: Record<string, { hasIdentifiedAIContent?: boolean } | null> }>(
            'https://pipe.deezer.com/api',
            { query },
            getDeezerAxiosConfig({ timeout: 10000, headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` } })
        );
        batch.forEach((id, i) => {
            const ai = Boolean(response.data?.data?.[`a${i}`]?.hasIdentifiedAIContent);
            cache.flags.set(id, { ai, at: now });
            result.set(id, ai);
        });
    }
    return result;
}

type Tagged = { qobuz_id?: unknown; deezer?: { id?: unknown; ai?: boolean } };

// Every normalized Deezer album in `value`, however deep (search buckets, an
// artist's releases, a track's album).
function deezerAlbums(value: unknown, found: Tagged[] = [], seen = new Set<unknown>()): Tagged[] {
    if (!value || typeof value !== 'object' || seen.has(value)) return found;
    seen.add(value);
    const item = value as Tagged;
    if (item.deezer && item.qobuz_id !== undefined) found.push(item);
    for (const child of Array.isArray(value) ? value : Object.values(value)) deezerAlbums(child, found, seen);
    return found;
}

export async function annotateDeezerAI<T>(value: T): Promise<T> {
    try {
        const albums = deezerAlbums(value);
        const flags = await getDeezerAIFlags(albums.map((album) => String(album.deezer!.id)));
        for (const album of albums) if (flags.get(String(album.deezer!.id))) album.deezer!.ai = true;
    } catch (error) {
        console.warn('Deezer AI tags skipped:', error instanceof Error ? error.message : error);
    }
    return value;
}
