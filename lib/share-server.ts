import axios from 'axios';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FetchedQobuzAlbum, QobuzTrack } from './qobuz-dl';
import { getDeezerAxiosConfig, getDeezerFullStreamURL } from './deezer-dl-server';
import { stripeDecryptStream } from './deezer-decrypt';

// Server only. Links that open a release in Tryptify, and the preview Discord
// shows for them.
//
// A link is https://tryptify.com/listen/<source>/album/<album>[/track/<track>]?isrc=…&title=…&artist=…&duration=…&s=<sig>:
// the Tryptify app opens it and plays the album (from that track, if named),
// from that source when the listener has it, else from whichever service they
// do have: the song's ISRC, title, artist and length let the app find it there;
// anyone else gets tryptify.com's page, whose Open Graph tags come from
// /api/share/meta and show the cover and /api/share/preview, a WebM of the
// cover with a 30-second clip in Opus at 256 kbps. Discord plays og:video but
// not og:audio, so the clip is a video of one still frame.
//
// Those two routes are open (Discord has no password), so they only answer
// links this server signed: `s` is an HMAC of the target, handed out by the
// password-guarded /api/share/link. Nobody else can make this server fetch
// and encode songs.

export const SHARE_SOURCES = ['qobuz', 'deezer', 'tidal', 'apple'] as const;
export type ShareSource = (typeof SHARE_SOURCES)[number];
export type ShareTarget = { source: ShareSource; album: string; track?: string };

export type ShareMeta = {
    source: ShareSource;
    kind: 'album' | 'track';
    title: string;
    artist: string;
    album: string;
    cover: string | null;
    duration: number;
    // The track's ISRC; for an album, its first track's.
    isrc: string | null;
};

const CLIP_SECONDS = 30;
const VIDEO_SIZE = 600;

function getSecret(): string {
    const secret = process.env.FILE_PROXY_SECRET || process.env.QOBUZ_SECRET;
    if (!secret) throw new Error('Deployment is missing FILE_PROXY_SECRET/QOBUZ_SECRET environment variable.');
    return secret;
}

const linkBase = () => (process.env.SHARE_LINK_BASE || 'https://tryptify.com').replace(/\/+$/, '');

export function sharePath({ source, album, track }: ShareTarget): string {
    return `/listen/${source}/album/${album}${track ? `/track/${track}` : ''}`;
}

// 96 bits of HMAC, base64url: short enough for a chat message, long enough
// that nobody guesses one.
export function shareSignature(target: ShareTarget): string {
    return crypto.createHmac('sha256', getSecret()).update(`share\n${sharePath(target)}`).digest().subarray(0, 12).toString('base64url');
}

export function verifyShareSignature(target: ShareTarget, signature: string | null | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(shareSignature(target));
    const given = Buffer.from(signature);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// The link, with what lets the listener's Tryptify find the song on another
// service when it hasn't this one: its ISRC, title, artist and (for a track)
// length. Those are not signed: they only help the app, which needs no
// signature, while the preview routes go by the signed path alone.
export function shareURL(target: ShareTarget, meta?: Pick<ShareMeta, 'isrc' | 'title' | 'artist' | 'duration' | 'kind'>): string {
    const query = new URLSearchParams();
    if (meta?.isrc) query.set('isrc', meta.isrc);
    if (meta?.title) query.set('title', meta.title.slice(0, 200));
    if (meta?.artist) query.set('artist', meta.artist.slice(0, 200));
    if (meta?.kind === 'track' && meta.duration > 0) query.set('duration', String(Math.round(meta.duration)));
    query.set('s', shareSignature(target));
    return `${linkBase()}${sharePath(target)}?${query}`;
}

async function loadAlbum({ source, album }: ShareTarget): Promise<FetchedQobuzAlbum> {
    switch (source) {
        case 'qobuz':
            return (await import('./qobuz-dl-server')).getAlbumInfo(album);
        case 'deezer':
            return (await import('./deezer-server')).getAlbumInfo(album);
        case 'tidal':
            return (await import('./tidal-server')).getAlbumInfo(album);
        case 'apple':
            return (await import('./apple-music-server')).getAlbumInfo(album);
    }
}

const coverOf = (album: FetchedQobuzAlbum): string | null => album.image?.large || album.image?.small || album.image?.thumbnail || null;

// The album, and the shared track on it (its first track for an album link).
async function resolve(target: ShareTarget): Promise<{ album: FetchedQobuzAlbum; track: QobuzTrack | undefined }> {
    const album = await loadAlbum(target);
    const items = album.tracks?.items ?? [];
    const track = target.track ? items.find((t) => String(t.id) === target.track) : items[0];
    if (target.track && !track) throw new Error('That track is not on that album.');
    return { album, track };
}

export async function getShareMeta(target: ShareTarget): Promise<ShareMeta> {
    const { album, track } = await resolve(target);
    const kind = target.track ? 'track' : 'album';
    return {
        source: target.source,
        kind,
        title: kind === 'track' && track ? track.title + (track.version ? ` (${track.version})` : '') : album.title,
        artist: (kind === 'track' && track?.performer?.name) || album.artist?.name || '',
        album: album.title,
        cover: coverOf(album),
        duration: kind === 'track' ? track?.duration ?? 0 : album.duration ?? 0,
        isrc: track?.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(track.isrc) ? track.isrc.toUpperCase() : null
    };
}

// --- The preview clip ------------------------------------------------------

type DeezerPublicTrack = { id: number; duration?: number; preview?: string; error?: unknown };

// The song on Deezer: itself for a Deezer link, else matched by ISRC.
async function deezerTrackFor(target: ShareTarget, track: QobuzTrack | undefined): Promise<DeezerPublicTrack | null> {
    const { deezerRequest } = await import('./deezer-server');
    const id = target.source === 'deezer' ? String(track?.id ?? '') : track?.isrc ? `isrc:${track.isrc}` : '';
    if (!id) return null;
    try {
        const found = await deezerRequest<DeezerPublicTrack>(`/track/${id}`);
        return found?.id ? found : null;
    } catch {
        return null;
    }
}

// The audio to cut the clip from, as a readable stream, and where in it the
// clip starts: the full FLAC with an ARL (decrypted as it streams), else
// Deezer's own 30-second MP3 preview from its start.
async function clipSource(song: DeezerPublicTrack): Promise<{ stream: NodeJS.ReadableStream; start: number }> {
    if (process.env.DEEZER_ARL) {
        try {
            const file = await getDeezerFullStreamURL(song.id, 'FLAC');
            const response = await axios.get(file.url, { ...getDeezerAxiosConfig(), headers: {}, responseType: 'stream', timeout: 20000 });
            const duration = file.duration || song.duration || 0;
            // A third of the way in, where a song is usually under way.
            const start = Math.max(0, Math.min(Math.round(duration / 3), duration - CLIP_SECONDS));
            return { stream: (response.data as NodeJS.ReadableStream).pipe(stripeDecryptStream(file.id)), start };
        } catch (error) {
            console.warn('Share preview: full file unavailable, using the MP3 preview:', error instanceof Error ? error.message : error);
        }
    }
    if (!song.preview) throw new Error('Deezer has no preview for this song.');
    const response = await axios.get(song.preview, { responseType: 'stream', timeout: 20000 });
    return { stream: response.data as NodeJS.ReadableStream, start: 0 };
}

function ffmpeg(args: string[], input: NodeJS.ReadableStream): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
        // ffmpeg stops reading once it has the clip; the rest of the song is not wanted.
        child.stdin.on('error', () => {});
        input.on('error', () => child.stdin.destroy());
        input.pipe(child.stdin);
        child.on('error', reject);
        child.on('close', (code) => {
            (input as unknown as { destroy?: () => void }).destroy?.();
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
        });
    });
}

const cacheDir = () => path.join(process.env.SHARE_CACHE_DIR || path.join(os.tmpdir(), 'trypt-share'));
const pending = new Map<string, Promise<string>>();

async function encodePreview(target: ShareTarget, out: string): Promise<void> {
    const { album, track } = await resolve(target);
    const song = await deezerTrackFor(target, track);
    if (!song) throw new Error('No preview: this song is not on Deezer.');
    const cover = coverOf(album);
    if (!cover) throw new Error('No preview: the release has no cover.');

    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trypt-share-'));
    // Beside its final name, so the rename below never crosses disks.
    const partial = `${out}.${process.pid}-${Date.now()}.part`;
    try {
        const coverFile = path.join(work, 'cover');
        const image = await axios.get(cover, { responseType: 'stream', timeout: 20000 });
        await pipeline(image.data as NodeJS.ReadableStream, fs.createWriteStream(coverFile));

        const { stream, start } = await clipSource(song);
        await ffmpeg(
            [
                '-hide_banner', '-loglevel', 'error',
                '-loop', '1', '-framerate', '1', '-i', coverFile,
                '-ss', String(start), '-t', String(CLIP_SECONDS), '-i', 'pipe:0',
                '-map', '0:v', '-map', '1:a',
                '-vf', `scale=${VIDEO_SIZE}:${VIDEO_SIZE}:force_original_aspect_ratio=decrease,pad=${VIDEO_SIZE}:${VIDEO_SIZE}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
                // One still frame a second: the picture costs next to nothing.
                '-c:v', 'libvpx-vp9', '-r', '1', '-crf', '32', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8',
                '-c:a', 'libopus', '-b:a', '256k',
                '-shortest', '-f', 'webm', partial
            ],
            stream
        );
        await fs.promises.rename(partial, out);
    } finally {
        await fs.promises.rm(work, { recursive: true, force: true });
        await fs.promises.rm(partial, { force: true });
    }
}

// The preview's file on disk, made once per target and then kept.
export async function getSharePreview(target: ShareTarget): Promise<string> {
    const key = crypto.createHash('sha256').update(sharePath(target)).digest('hex').slice(0, 32);
    const out = path.join(cacheDir(), `${key}.webm`);
    if (fs.existsSync(out)) return out;
    let job = pending.get(key);
    if (!job) {
        job = (async () => {
            await fs.promises.mkdir(cacheDir(), { recursive: true });
            await encodePreview(target, out);
            return out;
        })().finally(() => pending.delete(key));
        pending.set(key, job);
    }
    return job;
}

export const PREVIEW_SIZE = VIDEO_SIZE;

// The target named by a request's ?source=&album=&track=, checked. Qobuz album
// ids are slugs (letters and digits); every other id is a number.
export function parseShareTarget(params: URLSearchParams): ShareTarget {
    const source = params.get('source') as ShareSource;
    const album = params.get('album') ?? '';
    const track = params.get('track') || undefined;
    if (!SHARE_SOURCES.includes(source)) throw new Error('Unknown source.');
    if (!/^[A-Za-z0-9]{1,40}$/.test(album)) throw new Error('Bad album id.');
    if (track !== undefined && !/^\d{1,20}$/.test(track)) throw new Error('Bad track id.');
    return { source, album, track };
}
