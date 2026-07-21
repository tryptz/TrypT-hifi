// ---------------------------------------------------------------------------
// Server-only client for a locally running Apple Music decryption **wrapper**
// (zhaarey/wrapper — the patched Apple runtime that holds the FairPlay keys).
//
// The wrapper listens on raw TCP ports (NOT HTTP):
//
//   * 20020  get-m3u8   — resolve the *device* HLS master-playlist URL for an
//                         adamId. Apple gates the hi-res / Atmos master behind a
//                         real device; the developer-token web path cannot reach
//                         it, so it is resolved here. THIS is the only call the
//                         catalog layer makes to the wrapper.
//   * 10020  decrypt    — per-sample FairPlay decryption (cbcs). Driving this
//                         means reimplementing the whole apple-music-downloader
//                         (HLS media playlist + fragmented-MP4 parse + segment
//                         download + sample loop + mux). That stays on-device in
//                         Tryptify per docs/apple-music-atmos-in-tryptify.md — it
//                         is intentionally NOT implemented server-side here. The
//                         protocol constants below document the wire format for
//                         whoever builds that path.
//
// Opt-in: everything no-ops unless APPLE_WRAPPER_HOST is set. Keep this personal
// /research only — see the "Legal reality" section of the design doc.
// ---------------------------------------------------------------------------

// Lazy-require the Node builtin (this module must never be pulled into the
// client bundle; mirrors the guarded requires in lib/apple-music-server.tsx).
let netModule: typeof import('node:net') | undefined;
function net(): typeof import('node:net') {
    if (!netModule) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        netModule = require('node:net');
    }
    return netModule!;
}

const DEFAULT_M3U8_PORT = 20020;
const DEFAULT_DECRYPT_PORT = 10020;

function wrapperHost(): string {
    return process.env.APPLE_WRAPPER_HOST || '127.0.0.1';
}

function m3u8Port(): number {
    return Number(process.env.APPLE_WRAPPER_M3U8_PORT) || DEFAULT_M3U8_PORT;
}

function timeoutMs(): number {
    return Number(process.env.APPLE_WRAPPER_TIMEOUT_MS) || 8000;
}

// The wrapper integration is opt-in: only active when a host is explicitly
// configured. Callers gate on this so the default (web-only) behaviour is
// unchanged for anyone who has not stood up a local wrapper.
export function isWrapperConfigured(): boolean {
    return Boolean(process.env.APPLE_WRAPPER_HOST);
}

// --- Port 20020: resolve the device m3u8 master-playlist URL ----------------
//
// Wire protocol (from apple-music-downloader `checkM3u8`):
//   -> [1 byte: len(adamId)][adamId ASCII]
//   <- the master-playlist URL as UTF-8, terminated by '\n' (empty = unavailable)
// One request per connection; the server closes it afterwards.
export async function resolveDeviceM3u8(adamId: string): Promise<string | null> {
    const host = wrapperHost();
    const port = m3u8Port();
    const idBuf = Buffer.from(adamId, 'ascii');
    if (idBuf.length === 0) throw new Error('resolveDeviceM3u8: empty adamId');
    if (idBuf.length > 255) throw new Error(`resolveDeviceM3u8: adamId too long for the 1-byte length prefix: ${adamId}`);

    return new Promise<string | null>((resolve, reject) => {
        const socket = net().createConnection({ host, port });
        const chunks: Buffer[] = [];
        let settled = false;

        const finish = (err: Error | null, value?: string | null) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (err) reject(err);
            else resolve(value ?? null);
        };

        const emit = () => {
            const line = Buffer.concat(chunks).toString('utf8').trim();
            finish(null, line.length ? line : null);
        };

        socket.setTimeout(timeoutMs());
        socket.on('connect', () => {
            socket.write(Buffer.concat([Buffer.from([idBuf.length]), idBuf]));
        });
        socket.on('data', (d) => {
            chunks.push(d);
            if (Buffer.concat(chunks).includes(0x0a)) emit(); // got the terminating newline
        });
        socket.on('end', emit); // server may close without a trailing newline
        socket.on('timeout', () => finish(new Error(`wrapper get-m3u8 timed out after ${timeoutMs()}ms (${host}:${port})`)));
        socket.on('error', (e) => finish(e));
    });
}

// --- Port 10020: decrypt (protocol reference only — NOT implemented) ---------
//
// Documented so the on-device / downloader implementation has an exact wire
// spec. All integers are little-endian; string lengths are a single leading
// byte. Per protected sample: [uint32-LE byteCount][ciphertext] -> [byteCount
// plaintext]. Control frames: 4 zero bytes = switch keys, 5 zero bytes = close.
export const WRAPPER_DECRYPT_PROTOCOL = {
    port: DEFAULT_DECRYPT_PORT,
    switchKeysFrame: Uint8Array.of(0, 0, 0, 0),
    closeFrame: Uint8Array.of(0, 0, 0, 0, 0),
    prefetchKeyUri: 'skd://itunes.apple.com/P000000000/s1/e1',
    prefetchAdamId: '0',
} as const;

export function decryptPortAddress(): { host: string; port: number } {
    return { host: wrapperHost(), port: Number(process.env.APPLE_WRAPPER_DECRYPT_PORT) || DEFAULT_DECRYPT_PORT };
}
