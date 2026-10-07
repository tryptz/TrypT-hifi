import axios from 'axios';
import { DashPlan, proxyAgent } from './tidal-dash-server';

// ---------------------------------------------------------------------------
// A segment index (sidx) for the fragmented MP4s this server assembles from
// TIDAL's DASH segments: Dolby Atmos (E-AC-3 JOC) and AAC. Server-only.
//
// Joined end to end, init + segments play, but nothing in the file says where
// each fragment starts or when. ExoPlayer (Tryptify) then marks the file
// unseekable and drops every seek, so the playhead snaps back; other players
// fall back to scanning. A sidx right after the init segment lists every
// fragment's size and duration, which is what they seek by.
//
// It is written before any audio is sent: the durations come from the
// manifest's SegmentTimeline and the sizes from HEAD requests, so even a
// file still streaming progressively is seekable. The media segments are not
// touched, so the sizes HEAD reports are the sizes that follow the index.
// ---------------------------------------------------------------------------

export type SegmentIndex = {
    timescale: number;
    // When the first fragment starts, in timescale units.
    earliestPresentationTime: number;
    // Each fragment (one media segment) in file order.
    references: { size: number; duration: number }[];
};

const HEAD_CONCURRENCY = 16;
const HEAD_TIMEOUT_MS = 5000;
// No index rather than a late start: past this, the file goes out without one.
const INDEX_DEADLINE_MS = 8000;

/**
 * The index for [mediaURLs] (the media segments, in order) from the plan's
 * timeline and each segment's Content-Length. Null when there is no timeline,
 * a size cannot be had, or it takes longer than INDEX_DEADLINE_MS: the file
 * is then served as before, unindexed. Never rejects.
 */
export async function segmentIndex(mediaURLs: string[], timeline: DashPlan['timeline']): Promise<SegmentIndex | null> {
    if (!timeline || timeline.durations.length !== mediaURLs.length || mediaURLs.length === 0 || mediaURLs.length > 0xffff) return null;
    const agent = proxyAgent();
    const sizes: number[] = new Array(mediaURLs.length);
    let next = 0;
    const worker = async () => {
        while (next < mediaURLs.length) {
            const index = next++;
            const response = await axios.head(mediaURLs[index], { httpAgent: agent, httpsAgent: agent, timeout: HEAD_TIMEOUT_MS });
            const size = Number(response.headers['content-length']);
            if (!Number.isSafeInteger(size) || size <= 0 || size >= 2 ** 31) throw new Error(`No usable size for segment ${index + 1}.`);
            sizes[index] = size;
        }
    };
    const sized = Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, mediaURLs.length) }, worker)).then(
        () => true,
        () => false
    );
    const inTime = await Promise.race([sized, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), INDEX_DEADLINE_MS))]);
    if (!inTime) return null;
    return {
        timescale: timeline.timescale,
        earliestPresentationTime: timeline.start,
        references: sizes.map((size, i) => ({ size, duration: timeline.durations[i] }))
    };
}

/**
 * A version 1 sidx box (ISO/IEC 14496-12, 8.16.3) for [index], to be placed
 * immediately before the first fragment (first_offset 0). [trackId] is the
 * indexed track's tkhd track_ID, which some demuxers (ffmpeg) match on.
 */
export function sidxBox(trackId: number, index: SegmentIndex): Buffer {
    const count = index.references.length;
    const box = Buffer.alloc(8 + 4 + 4 + 4 + 8 + 8 + 4 + count * 12);
    let at = 0;
    box.writeUInt32BE(box.length, at);
    box.write('sidx', at + 4, 'latin1');
    at += 8;
    box.writeUInt32BE(0x01000000, at); // version 1, flags 0
    box.writeUInt32BE(trackId >>> 0, at + 4); // reference_ID
    box.writeUInt32BE(index.timescale >>> 0, at + 8);
    box.writeBigUInt64BE(BigInt(index.earliestPresentationTime), at + 12);
    box.writeBigUInt64BE(BigInt(0), at + 20); // first_offset: the first fragment follows at once
    box.writeUInt16BE(0, at + 28); // reserved
    box.writeUInt16BE(count, at + 30);
    at += 32;
    for (const { size, duration } of index.references) {
        box.writeUInt32BE(size & 0x7fffffff, at); // reference_type 0 (media), referenced_size
        box.writeUInt32BE(duration >>> 0, at + 4); // subsegment_duration
        box.writeUInt32BE(0x90000000, at + 8); // starts_with_SAP 1, SAP_type 1, SAP_delta_time 0
        at += 12;
    }
    return box;
}

/** The track_ID of the first track in [init]'s moov (its tkhd), or 1 when it cannot be read. */
export function firstTrackId(init: Buffer): number {
    const find = (type: string, start: number, end: number): { start: number; end: number } | null => {
        for (let at = start; at + 8 <= end; ) {
            const size = init.readUInt32BE(at);
            if (size < 8 || at + size > end) return null;
            if (init.toString('latin1', at + 4, at + 8) === type) return { start: at + 8, end: at + size };
            at += size;
        }
        return null;
    };
    const moov = find('moov', 0, init.length);
    const trak = moov && find('trak', moov.start, moov.end);
    const tkhd = trak && find('tkhd', trak.start, trak.end);
    if (!tkhd) return 1;
    // version 0: creation and modification times are 32-bit; version 1: 64-bit.
    const offset = tkhd.start + 4 + (init[tkhd.start] === 1 ? 16 : 8);
    return offset + 4 <= tkhd.end ? init.readUInt32BE(offset) || 1 : 1;
}
