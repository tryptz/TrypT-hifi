import { tidalRequest } from './tidal-server';
import { BuildPlan, describeDash, numberAttr, openDash, openTag, planFromMPD } from './tidal-dash-server';
import { flacFramesFromSegment, flacHeaderFromInit } from './flac-mp4';

// ---------------------------------------------------------------------------
// Server-only TIDAL stereo streams. Do NOT import into the client.
//
// /track/ (TIDAL's playbackinfo) answers with a base64 manifest that is either
//   - BTS JSON ({ mimeType, encryptionType, urls }): one file, proxied as-is
//     through a signed /api/file link; or
//   - a DASH MPD: an init segment + media segments, assembled by
//     lib/tidal-dash-server.ts and served from /api/tidal/stream-file.
// Which one comes back depends on the account and client (some get DASH for
// every quality). FLAC segments are remuxed into a plain .flac on the way, so
// browsers, ffmpeg and the tagger see the same file a BTS stream would give.
// ---------------------------------------------------------------------------

// Qobuz quality ids (what the settings + download pipeline speak) -> TIDAL qualities.
const QUALITY_MAP: Record<string, TidalQuality> = {
    '27': 'HI_RES_LOSSLESS',
    '7': 'HI_RES_LOSSLESS',
    '6': 'LOSSLESS',
    '5': 'HIGH'
};

export const TIDAL_QUALITIES = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'] as const;
export type TidalQuality = (typeof TIDAL_QUALITIES)[number];

const isLossless = (quality: TidalQuality) => quality === 'HI_RES_LOSSLESS' || quality === 'LOSSLESS';

// Lossless streams are FLAC (.flac after the remux); HIGH / LOW are AAC in MP4.
export const streamFormat = (quality: TidalQuality) =>
    isLossless(quality) ? { ext: 'flac', contentType: 'audio/flac' } : { ext: 'm4a', contentType: 'audio/mp4' };

export type StereoStreamInfo = { codec: string; quality: TidalQuality; bandwidth: number | null; sampleRate: number | null };

type Manifest = { kind: 'file'; url: string; codecs: string } | { kind: 'dash'; mpd: string } | null;

// Instances answer { version, data: X }; older ones answer X directly.
const unwrap = (body: any) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

const playbackInfo = async (trackId: string, quality: TidalQuality) => unwrap(await tidalRequest('/track/', { id: trackId, quality }));

function decodeManifest(data: any): Manifest {
    if (!data?.manifest) return null;
    const decoded = Buffer.from(data.manifest, 'base64').toString('utf8');
    if (data.manifestMimeType === 'application/dash+xml' || decoded.includes('<MPD')) return { kind: 'dash', mpd: decoded };
    try {
        const json = JSON.parse(decoded) as { urls?: string[]; encryptionType?: string; codecs?: string };
        if (json.encryptionType && json.encryptionType !== 'NONE') return null;
        return json.urls?.[0] ? { kind: 'file', url: json.urls[0], codecs: json.codecs || '' } : null;
    } catch {
        const url = decoded.match(/https?:\/\/\S+/)?.[0];
        return url ? { kind: 'file', url, codecs: '' } : null;
    }
}

// The quality TIDAL actually delivered (e.g. LOSSLESS for a track without a hi-res master).
const deliveredQuality = (data: any, requested: TidalQuality): TidalQuality =>
    (TIDAL_QUALITIES as readonly string[]).includes(data?.audioQuality) ? data.audioQuality : requested;

const streamKey = (trackId: string, quality: TidalQuality) => `stream-${trackId}-${quality}`;

function dashPlan(mpd: string, quality: TidalQuality): BuildPlan<StereoStreamInfo> {
    const flac = isLossless(quality);
    const plan = planFromMPD(mpd, 'https://tidal.com/', flac ? { codecs: /^flac$/i, name: 'FLAC' } : { codecs: /^mp4a/i, name: 'AAC' });
    if (flac && !plan.initialization) throw new Error('TIDAL sent a FLAC stream without an init segment.');
    const { rep, codecs, bandwidth } = plan.representation;
    return {
        urls: plan.urls,
        info: { codec: codecs, quality, bandwidth: bandwidth || null, sampleRate: numberAttr(openTag(rep), 'audioSamplingRate') },
        // FLAC: the init segment becomes the .flac header, each media segment its frames.
        // AAC stays fragmented MP4, which browsers and ffmpeg read as-is.
        transform: flac ? (index, data) => (index === 0 ? flacHeaderFromInit(data, plan.duration) : flacFramesFromSegment(data)) : undefined
    };
}

// For /api/tidal/stream-file when nothing is cached or building: a fresh manifest for exactly this quality.
function freshPlan(trackId: string, quality: TidalQuality) {
    return async (): Promise<BuildPlan<StereoStreamInfo>> => {
        const data = await playbackInfo(trackId, quality);
        const manifest = decodeManifest(data);
        if (!manifest) throw new Error('TIDAL returned no playable stream for this track.');
        if (manifest.kind === 'dash') return dashPlan(manifest.mpd, quality);
        return { urls: [manifest.url], info: { codec: manifest.codecs, quality, bandwidth: null, sampleRate: null } };
    };
}

export type ResolvedStream = { kind: 'file'; url: string } | { kind: 'dash'; quality: TidalQuality };

/**
 * Resolves a track (at a Qobuz quality id) to something the browser can fetch:
 * a single-file URL (to proxy through /api/file), or a DASH stream for
 * /api/tidal/stream-file, whose assembly starts here so the first GET finds
 * segments waiting. Hi-res that can't be served falls back to 16-bit LOSSLESS.
 */
export async function resolveStream(trackId: string, qualityId: string): Promise<ResolvedStream | null> {
    const requested = QUALITY_MAP[qualityId] || 'LOSSLESS';
    try {
        const data = await playbackInfo(trackId, requested);
        const manifest = decodeManifest(data);
        if (manifest?.kind === 'file') return { kind: 'file', url: manifest.url };
        if (manifest?.kind === 'dash') {
            const quality = deliveredQuality(data, requested);
            await describeDash(streamKey(trackId, quality), streamFormat(quality).ext, async () => dashPlan(manifest.mpd, quality));
            return { kind: 'dash', quality };
        }
    } catch (error) {
        if (requested !== 'HI_RES_LOSSLESS') throw error;
    }
    return requested === 'HI_RES_LOSSLESS' ? resolveStream(trackId, '6') : null;
}

// Either the cached file, or a live build a progressive reader can stream from.
export async function openStream(trackId: string, quality: TidalQuality) {
    return openDash(streamKey(trackId, quality), streamFormat(quality).ext, freshPlan(trackId, quality));
}
