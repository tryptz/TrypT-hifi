// ---------------------------------------------------------------------------
// FLAC in fragmented MP4 -> plain .flac, losslessly (no decode, no re-encode).
//
// Per "Encapsulation of FLAC in ISO Base Media File Format", the init segment's
// fLaC sample entry carries a dfLa box holding the FLAC metadata blocks
// (STREAMINFO first), and every media segment's mdat holds whole FLAC frames.
// A .flac file is "fLaC" + those metadata blocks + the frames, so the remux
// only copies bytes; the one edit is filling in STREAMINFO's total-samples
// field, which streaming encoders leave 0 ("unknown"), so players know the
// duration up front.
// ---------------------------------------------------------------------------

type Box = { type: string; start: number; end: number; header: number };

// The boxes laid end to end in buf[start, end).
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

// First child box of `type`; `skip` jumps a parent's own fields (full-box version/flags, sample-entry fields).
function child(buf: Buffer, parent: Box | null, type: string, skip = 0): Box | null {
    const start = (parent ? parent.start + parent.header : 0) + skip;
    return boxes(buf, start, parent ? parent.end : buf.length).find((box) => box.type === type) ?? null;
}

const STREAMINFO_LENGTH = 34;
// Bytes of an AudioSampleEntry before its child boxes (SampleEntry + audio fields).
const AUDIO_SAMPLE_ENTRY_FIELDS = 28;

/**
 * The .flac header ("fLaC" + metadata blocks) from a FLAC-in-MP4 init segment.
 * `duration` (in timescale units, from the DASH manifest) fills in STREAMINFO's
 * total samples when the encoder left it 0.
 */
export function flacHeaderFromInit(init: Buffer, duration: { ticks: number; timescale: number } | null): Buffer {
    let box: Box | null = null;
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']) {
        box = child(init, box, type);
        if (!box) throw new Error(`The FLAC init segment has no ${type} box.`);
    }
    const entry = child(init, box, 'fLaC', 8); // stsd: version/flags + entry_count
    const dfla = entry && child(init, entry, 'dfLa', AUDIO_SAMPLE_ENTRY_FIELDS);
    if (!dfla) throw new Error('The init segment carries no FLAC (dfLa) configuration.');

    const blocks = Buffer.from(init.subarray(dfla.start + dfla.header + 4, dfla.end)); // a copy, past version/flags
    if (blocks.length < 4 + STREAMINFO_LENGTH || (blocks[0] & 0x7f) !== 0 || blocks.readUIntBE(1, 3) !== STREAMINFO_LENGTH)
        throw new Error('The FLAC configuration does not start with STREAMINFO.');

    // STREAMINFO body (after the 4-byte block header): sample rate is 20 bits at bit 80,
    // total samples 36 bits at bit 108 (low nibble of byte 13, then bytes 14-17).
    const body = 4;
    const sampleRate = (blocks[body + 10] << 12) | (blocks[body + 11] << 4) | (blocks[body + 12] >> 4);
    const totalSamples = (blocks[body + 13] & 0x0f) * 2 ** 32 + blocks.readUInt32BE(body + 14);
    if (totalSamples === 0 && duration && sampleRate > 0) {
        const samples = Math.round((duration.ticks * sampleRate) / duration.timescale);
        if (samples > 0 && samples < 2 ** 36) {
            blocks[body + 13] = (blocks[body + 13] & 0xf0) | Math.floor(samples / 2 ** 32);
            blocks.writeUInt32BE(samples % 2 ** 32, body + 14);
        }
    }
    return Buffer.concat([Buffer.from('fLaC', 'latin1'), blocks]);
}

/** The FLAC frames of one FLAC-in-MP4 media segment (its mdat payloads, in order). */
export function flacFramesFromSegment(segment: Buffer): Buffer {
    const frames = Buffer.concat(
        boxes(segment)
            .filter((box) => box.type === 'mdat')
            .map((box) => segment.subarray(box.start + box.header, box.end))
    );
    // Every FLAC frame starts with the 14-bit sync code 11111111 111110xx.
    if (frames.length < 2 || frames[0] !== 0xff || (frames[1] & 0xfe) !== 0xf8) throw new Error('A FLAC media segment does not start with a FLAC frame.');
    return frames;
}
