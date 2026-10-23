// Shared by the tests: a file as Deezer's CDN serves it.
import { Blowfish } from '../lib/blowfish';
import { DEEZER_BLOCK as BLOCK, deezerKey } from '../lib/deezer-decrypt';

const IV = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

// How Deezer's CDN serves `plain` for song `id`: every third whole block
// (0, 3, 6, …) Blowfish-CBC encrypted on its own, from the IV.
export function striped(id: string | number, plain: Uint8Array): Buffer {
    const out = Buffer.from(plain);
    const bf = new Blowfish(deezerKey(id));
    for (let i = 0; i * BLOCK + BLOCK <= out.length; i++) {
        if (i % 3 === 0) bf.encryptCbc(out.subarray(i * BLOCK, (i + 1) * BLOCK), IV);
    }
    return out;
}

// Bytes that never repeat on a block boundary.
export function plainFile(length: number): Buffer {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i++) out[i] = (i * 31) % 251;
    return out;
}
