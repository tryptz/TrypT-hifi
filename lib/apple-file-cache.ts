import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Short-lived cache for decrypted audio that the home wrapper/downloader uploads
// back to the cloud app. Files live only long enough to stream/download once
// (default 10 min) and are then swept. Storage is the local filesystem — a
// Railway volume if one is mounted at APPLE_CACHE_DIR, otherwise the container's
// tmp dir, which is fine given how briefly the files exist.
//
//   PUT  /api/apple/files/:adamId   (home -> cloud, X-Upload-Token auth)
//   GET  /api/apple/files/:adamId   (browser/native, signed URL, Range-capable)
// ---------------------------------------------------------------------------

const ADAM_RE = /^\d{1,20}$/;

export function cacheDir(): string {
    return process.env.APPLE_CACHE_DIR || path.join(os.tmpdir(), 'apple-cache');
}

export function ttlSeconds(): number {
    return Number(process.env.APPLE_CACHE_TTL_SECONDS) || 600;
}

// adamId is validated (digits only) so it can never escape the cache dir.
export function cacheFilePath(adamId: string): string {
    if (!ADAM_RE.test(adamId)) throw new Error('invalid adamId');
    return path.join(cacheDir(), `${adamId}.m4a`);
}

export async function ensureCacheDir(): Promise<void> {
    await fs.promises.mkdir(cacheDir(), { recursive: true });
}

// Delete cache files older than the TTL. Called opportunistically per request so
// no background timer is needed (fits the serverless-ish Railway model).
export async function sweepExpired(): Promise<void> {
    const dir = cacheDir();
    let entries: string[];
    try {
        entries = await fs.promises.readdir(dir);
    } catch {
        return;
    }
    const cutoff = Date.now() - ttlSeconds() * 1000;
    await Promise.all(
        entries.map(async (name) => {
            const p = path.join(dir, name);
            try {
                const st = await fs.promises.stat(p);
                if (st.mtimeMs < cutoff) await fs.promises.unlink(p);
            } catch {
                // racing sweep/unlink; ignore
            }
        })
    );
}

// See lib/file-proxy.ts: FILE_PROXY_SECRET is the real key here; the
// QOBUZ_SECRET fallback is legacy and rotates out from under signed URLs.
function getSecret(): string {
    const secret = process.env.FILE_PROXY_SECRET || process.env.QOBUZ_SECRET;
    if (!secret)
        throw new Error(
            'Deployment is missing FILE_PROXY_SECRET. Set it to any long random string — it signs Apple stream URLs and is unrelated to Qobuz credentials.'
        );
    return secret;
}

function sign(adamId: string, exp: number): string {
    return crypto.createHmac('sha256', getSecret()).update(`apple-file\n${adamId}\n${exp}`).digest('hex');
}

// Browser-usable signed URL. The signature TTL is deliberately long (default 6h)
// and independent of the file TTL: the link stays valid so the user can trigger
// the download later; the *file* still only exists for ttlSeconds() after upload.
export function signStreamURL(adamId: string, origin: string, sigTtlSeconds = 6 * 60 * 60): string {
    const exp = Math.floor(Date.now() / 1000) + sigTtlSeconds;
    const u = new URL(`/api/apple/files/${adamId}`, origin);
    u.searchParams.set('exp', String(exp));
    u.searchParams.set('sig', sign(adamId, exp));
    return u.toString();
}

export function verifyStreamSig(adamId: string, exp: number, sig: string): 'ok' | 'invalid' | 'expired' {
    if (!ADAM_RE.test(adamId)) return 'invalid';
    let expected: Buffer;
    let provided: Buffer;
    try {
        expected = Buffer.from(sign(adamId, exp), 'hex');
        provided = Buffer.from(sig, 'hex');
    } catch {
        return 'invalid';
    }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return 'invalid';
    if (exp < Math.floor(Date.now() / 1000)) return 'expired';
    return 'ok';
}

// Upload auth: a shared secret the home uploader sends in X-Upload-Token. Kept
// separate from the stream-signing secret so a leaked stream URL can never be
// used to overwrite cached content.
export function verifyUploadToken(token: string | null): boolean {
    const secret = process.env.APPLE_UPLOAD_SECRET;
    if (!secret || !token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
