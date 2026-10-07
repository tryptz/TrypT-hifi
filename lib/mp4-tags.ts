import axios from 'axios';
import { tidalRequest } from './tidal-server';
import { proxyAgent, SegmentTransform } from './tidal-dash-server';

// ---------------------------------------------------------------------------
// iTunes-style tags (moov > udta > meta > ilst) for the fragmented MP4s this
// server assembles from TIDAL's DASH segments: Dolby Atmos (E-AC-3 JOC) and
// AAC. Server-only.
//
// Those files used to reach clients with no tags at all, so a library filed
// every one under "Unknown Album" by "Unknown Artist", and tag editors cannot
// fix them: JAudioTagger and friends rewrite MP4 chunk offsets and refuse a
// fragmented file. Here the tags go into the init segment's moov, ahead of
// every fragment. The fragments address their samples relative to their own
// moof, which is also why concatenating segments works at all, so growing the
// init segment moves nothing they point at. The audio is not touched.
// ---------------------------------------------------------------------------

export type Mp4Tags = {
    title?: string;
    artist?: string;
    album?: string;
    albumArtist?: string;
    date?: string;
    genre?: string;
    comment?: string;
    track?: { number: number; total?: number };
    disc?: { number: number; total?: number };
    cover?: Buffer;
};

type Box = { type: string; start: number; end: number; header: number };

function boxes(buf: Buffer, start = 0, end = buf.length): Box[] {
    const found: Box[] = [];
    let offset = start;
    while (offset + 8 <= end) {
        let size = buf.readUInt32BE(offset);
        const type = buf.toString('latin1', offset + 4, offset + 8);
        let header = 8;
        if (size === 1) {
            size = Number(buf.readBigUInt64BE(offset + 8));
            header = 16;
        } else if (size === 0) size = end - offset;
        if (size < header || offset + size > end) throw new Error(`Malformed MP4 box "${type}".`);
        found.push({ type, start: offset, end: offset + size, header });
        offset += size;
    }
    return found;
}

function box(type: string, ...payload: Buffer[]): Buffer {
    const body = Buffer.concat(payload);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
}

// An ilst item: the atom named `type` holding one `data` atom.
function item(type: string, dataType: number, value: Buffer): Buffer {
    const header = Buffer.alloc(8); // version 0 + 24-bit type, then a zero locale
    header.writeUInt32BE(dataType, 0);
    return box(type, box('data', header, value));
}

const text = (type: string, value: string | undefined) => (value ? item(type, 1, Buffer.from(value, 'utf8')) : null);

function numberPair(type: string, pair: { number: number; total?: number } | undefined, trailing: boolean) {
    if (!pair || !(pair.number > 0)) return null;
    const value = Buffer.alloc(trailing ? 8 : 6);
    value.writeUInt16BE(Math.min(pair.number, 0xffff), 2);
    value.writeUInt16BE(Math.min(pair.total ?? 0, 0xffff), 4);
    return item(type, 0, value);
}

function coverItem(cover: Buffer | undefined) {
    if (!cover) return null;
    const png = cover.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return item('covr', png ? 14 : 13, cover);
}

function metaBox(tags: Mp4Tags): Buffer {
    const items = [
        text('©nam', tags.title),
        text('©ART', tags.artist),
        text('©alb', tags.album),
        text('aART', tags.albumArtist),
        text('©day', tags.date),
        text('©gen', tags.genre),
        text('©cmt', tags.comment),
        numberPair('trkn', tags.track, true),
        numberPair('disk', tags.disc, false),
        coverItem(tags.cover)
    ].filter((entry): entry is Buffer => entry !== null);
    // hdlr: version/flags, pre_defined, handler "mdir", reserved "appl" + 8 zero bytes, empty name.
    const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from('mdirappl', 'latin1'), Buffer.alloc(9));
    return box('meta', Buffer.alloc(4), hdlr, box('ilst', ...items));
}

/**
 * [init] (an init segment, or a whole fragmented MP4) with [tags] in its moov,
 * replacing any iTunes tags already there. Everything outside the moov's udta
 * is copied as it is. Without a moov, [init] comes back unchanged.
 */
export function withMp4Tags(init: Buffer, tags: Mp4Tags): Buffer {
    const top = boxes(init);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) return init;
    const children = boxes(init, moov.start + moov.header, moov.end);
    const udta = children.find((b) => b.type === 'udta');
    const keptUdta = udta
        ? boxes(init, udta.start + udta.header, udta.end)
              .filter((b) => b.type !== 'meta')
              .map((b) => init.subarray(b.start, b.end))
        : [];
    const newMoov = box(
        'moov',
        ...children.filter((b) => b.type !== 'udta').map((b) => init.subarray(b.start, b.end)),
        box('udta', ...keptUdta, metaBox(tags))
    );
    return Buffer.concat([init.subarray(0, moov.start), newMoov, init.subarray(moov.end)]);
}

/**
 * A DASH segment transform that tags the init segment (index 0) once [tags]
 * arrive and passes every other segment through. Taking the tags as a promise
 * lets a build start, and the server answer, while they are still being
 * fetched; only storing segment 0 waits for them. Null tags leave it as is.
 */
export const tagInitSegment =
    (tags: Promise<Mp4Tags | null>): SegmentTransform =>
    async (index, data) => {
        if (index !== 0) return data;
        const found = await tags;
        return found ? withMp4Tags(data, found) : data;
    };

// --- Tags for a TIDAL track -----------------------------------------------------

const unwrap = (body: any) => (body && typeof body === 'object' && 'data' in body ? body.data : body);
const coverURL = (uuid: string) => `https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/1280x1280.jpg`;

/**
 * The tags for TIDAL track [trackId], from its own record and its album's —
 * the album artist, year and totals come from the album, as the app's own
 * FLAC tags do, so the files group into the same album. Null when TIDAL does
 * not answer: the file is then served untagged rather than not at all.
 */
export async function tidalTrackTags(trackId: string, comment?: string): Promise<Mp4Tags | null> {
    try {
        const track = unwrap(await tidalRequest('/info/', { id: trackId }));
        if (!track?.title) return null;
        const albumId = track.album?.id;
        const [album, cover] = await Promise.all([
            albumId
                ? tidalRequest('/album/', { id: albumId, limit: 1 })
                      .then(unwrap)
                      .catch(() => null)
                : null,
            track.album?.cover
                ? axios
                      .get(coverURL(track.album.cover), { responseType: 'arraybuffer', httpAgent: proxyAgent(), httpsAgent: proxyAgent() })
                      .then((r) => Buffer.from(r.data))
                      .catch(() => undefined)
                : undefined
        ]);
        const artists: string[] = (track.artists ?? []).map((a: any) => a?.name).filter(Boolean);
        return {
            title: track.version ? `${track.title} (${track.version})` : track.title,
            artist: artists.length ? artists.join(', ') : track.artist?.name,
            album: album?.title ?? track.album?.title,
            albumArtist: album?.artist?.name ?? track.artist?.name,
            date: album?.releaseDate ?? track.streamStartDate?.slice(0, 10),
            comment,
            track: track.trackNumber ? { number: track.trackNumber, total: album?.numberOfTracks } : undefined,
            disc: track.volumeNumber ? { number: track.volumeNumber, total: album?.numberOfVolumes } : undefined,
            cover
        };
    } catch {
        return null;
    }
}
