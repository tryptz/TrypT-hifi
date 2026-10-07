import axios from 'axios';
import { tidalRequest } from './tidal-server';
import { BuildPlan, attr, dashFile, describeDash, numberAttr, openDash, openTag, planFromMPD as planDash, proxyAgent } from './tidal-dash-server';
import { tagInitSegment, tidalTrackTags } from './mp4-tags';

// ---------------------------------------------------------------------------
// Server-only TIDAL Dolby Atmos (E-AC-3 JOC) files. Do NOT import into the client.
//
// The HiFi API only hands out Atmos through /trackManifests/?formats=EAC3_JOC,
// which answers with a DASH manifest; lib/tidal-dash-server.ts fetches its
// segments and concatenates them into a single fragmented MP4, byte-for-byte
// what TIDAL serves. Nothing is re-encoded, downmixed or remuxed: the full mix
// — the 5.1 bed plus every JOC object and its OAMD positional metadata —
// reaches the client intact, so a downstream renderer (an AVR, Tryptify's
// object renderer) can render it to any speaker layout.
// ---------------------------------------------------------------------------

const TRACK_ID_RE = /^\d{1,20}$/;
const ATMOS = { codecs: /ec-3|eac3/i, name: 'E-AC-3 (Atmos)' };

// --- Stream description --------------------------------------------------------

// What the client is getting, so a player can tell a full Atmos mix apart from a
// stereo fallback before it decodes anything.
export type AtmosStreamInfo = {
    codec: string; // e.g. "ec-3"
    bandwidth: number | null; // bits per second
    sampleRate: number | null;
    // Dolby channel configuration of the bed, e.g. "F801" = 5.1 (L R C LFE Ls Rs).
    channelConfiguration: string | null;
    bedChannels: number | null;
    // "JOC" when the stream carries Joint Object Coding (the Atmos objects).
    extensionType: string | null;
    // JOC complexity index = the maximum number of simultaneously coded objects.
    objectCount: number | null;
};

// Dolby's 16-bit channel-configuration mask (ETSI TS 102 366 Annex I / DASH-IF IOP):
// bits, MSB first: L, C, R, Ls, Rs, Lc/Rc pair, Lrs/Rrs pair, Cs, Ts, Lsd/Rsd pair,
// Lw/Rw pair, Vhl/Vhr pair, Vhc, Lts/Rts pair, LFE2, LFE.
const DOLBY_CHANNEL_BITS = [1, 1, 1, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1, 2, 1, 1];

export function bedChannelsFromDolbyConfig(value: string | null | undefined): number | null {
    if (!value || !/^[0-9a-f]{4}$/i.test(value)) return null;
    const mask = parseInt(value, 16);
    let channels = 0;
    for (let bit = 0; bit < 16; bit++) if (mask & (1 << (15 - bit))) channels += DOLBY_CHANNEL_BITS[bit];
    return channels;
}

// --- Manifest -----------------------------------------------------------------

async function fetchAtmosManifestURL(trackId: string): Promise<string> {
    const body = await tidalRequest('/trackManifests/', {
        id: trackId,
        formats: 'EAC3_JOC',
        adaptive: 'false',
        manifestType: 'MPEG_DASH',
        uriScheme: 'HTTPS',
        usage: 'PLAYBACK'
    });
    // { version, data: { data: { attributes } } } — the inner envelope is TIDAL's JSON:API.
    const attributes = body?.data?.data?.attributes ?? body?.data?.attributes;
    if (!attributes?.uri) throw new Error('TIDAL returned no manifest for this track.');
    const formats: string[] = attributes.formats || [];
    // Asking only for EAC3_JOC still yields a stereo manifest when the track has no
    // Atmos mix, and also when TIDAL withholds Atmos from this login's client. The
    // formats it did offer tell those apart in a client's log.
    if (!formats.includes('EAC3_JOC')) {
        throw new Error(`TIDAL gave this server no Dolby Atmos stream for this track (it offered ${formats.join(', ') || 'no formats'}).`);
    }
    if (attributes.drmData) throw new Error('TIDAL served this Atmos stream DRM-protected, so it cannot be downloaded.');
    return attributes.uri;
}

// Dolby DASH descriptors, from either the Representation or its AdaptationSet.
function dolbyProperty(scopes: string[], scheme: RegExp): string | null {
    for (const scope of scopes) {
        for (const tag of scope.match(/<(?:SupplementalProperty|EssentialProperty|AudioChannelConfiguration)\b[^>]*>/g) || []) {
            if (scheme.test(attr(tag, 'schemeIdUri') || '')) return attr(tag, 'value') ?? null;
        }
    }
    return null;
}

export type AtmosPlan = { urls: string[]; info: AtmosStreamInfo; initialization: boolean };

export function planFromMPD(mpd: string, mpdUrl: string): AtmosPlan {
    const { urls, representation, initialization } = planDash(mpd, mpdUrl, ATMOS);
    const { rep, set, setOwn, codecs, bandwidth } = representation;
    const scopes = [rep, setOwn];
    const channelConfiguration = dolbyProperty(scopes, /audio_channel_configuration/i);
    const complexity = Number(dolbyProperty(scopes, /EC3_ExtensionComplexityIndex/i));
    const info: AtmosStreamInfo = {
        codec: codecs,
        bandwidth: bandwidth || null,
        sampleRate: numberAttr(openTag(rep), 'audioSamplingRate') ?? numberAttr(openTag(set), 'audioSamplingRate'),
        channelConfiguration,
        bedChannels: bedChannelsFromDolbyConfig(channelConfiguration),
        extensionType: dolbyProperty(scopes, /EC3_ExtensionType/i),
        objectCount: Number.isFinite(complexity) && complexity > 0 ? complexity : null
    };
    return { urls, info, initialization };
}

// Kept for the original single-representation callers/tests.
export const segmentURLsFromMPD = (mpd: string, mpdUrl: string) => planFromMPD(mpd, mpdUrl).urls;

// --- Files ----------------------------------------------------------------------

// "t1": Atmos files carry tags since; untagged ones built before are not reused.
const atmosKey = (trackId: string) => `atmos-t1-${trackId}`;

function atmosPlan(trackId: string) {
    return async (): Promise<BuildPlan<AtmosStreamInfo>> => {
        // The tags are fetched alongside the manifest and not waited for here:
        // the plan, and so /api/tidal/download-music's answer, needs only the
        // manifest. Storing the init segment waits for them (tagInitSegment).
        // The file's tags say it is Atmos: the audio is passed through
        // untouched, only its init segment grows. tidalTrackTags never rejects.
        const tags = tidalTrackTags(trackId, 'Dolby Atmos');
        const mpdUrl = await fetchAtmosManifestURL(trackId);
        const agent = proxyAgent();
        const mpd = (await axios.get(mpdUrl, { responseType: 'text', httpAgent: agent, httpsAgent: agent })).data as string;
        const { urls, info, initialization } = planFromMPD(mpd, mpdUrl);
        return {
            urls,
            info,
            transform: initialization ? tagInitSegment(tags) : undefined
        };
    };
}

const validate = (trackId: string) => {
    if (!TRACK_ID_RE.test(trackId)) throw new Error('ID must be numeric');
};

// Path of the assembled Atmos file, building it (once, even under concurrent
// HEAD/GET requests) when it isn't cached yet.
export async function getAtmosFile(trackId: string): Promise<string> {
    validate(trackId);
    return dashFile(atmosKey(trackId), 'm4a', atmosPlan(trackId));
}

// Either the cached file, or a live build a progressive reader can stream from.
export async function openAtmos(trackId: string) {
    validate(trackId);
    return openDash(atmosKey(trackId), 'm4a', atmosPlan(trackId));
}

// Checks the track has a downloadable Atmos mix and describes it, so
// /api/tidal/download-music fails fast with a clear message for a non-Atmos
// track and tells the client exactly what it is about to receive.
export async function describeAtmos(trackId: string): Promise<AtmosStreamInfo> {
    validate(trackId);
    return describeDash(atmosKey(trackId), 'm4a', atmosPlan(trackId));
}
