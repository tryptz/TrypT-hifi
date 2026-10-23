// lib/blowfish.ts against Eric Young's test vectors and against OpenSSL.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { Blowfish } from '../lib/blowfish';

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();

// Eric Young's ECB vectors (key, plaintext, ciphertext), as in Schneier's
// reference set.
const ECB: [string, string, string][] = [
    ['0000000000000000', '0000000000000000', '4EF997456198DD78'],
    ['FFFFFFFFFFFFFFFF', 'FFFFFFFFFFFFFFFF', '51866FD5B85ECB8A'],
    ['3000000000000000', '1000000000000001', '7D856F9A613063F2'],
    ['1111111111111111', '1111111111111111', '2466DD878B963C9D'],
    ['0123456789ABCDEF', '1111111111111111', '61F9C3802281B096'],
    ['1111111111111111', '0123456789ABCDEF', '7D0CC630AFDA1EC7'],
    ['FEDCBA9876543210', '0123456789ABCDEF', '0ACEAB0FC6A0A28D'],
    ['7CA110454A1A6E57', '01A1D6D039776742', '59C68245EB05282B'],
    ['0131D9619DC1376E', '5CD54CA83DEF57DA', 'B1B8CC0B250F09A0'],
    ['07A1133E4A0B2686', '0248D43806F67172', '1730E5778BEA1DA4'],
    ['3849674C2602319E', '51454B582DDF440A', 'A25E7856CF2651EB'],
    ['04B915BA43FEB5B6', '42FD443059577FA2', '353882B109CE8F1A'],
    ['0113B970FD34F2CE', '059B5E0851CF143A', '48F4D0884C379918'],
    ['0170F175468FB5E6', '0756D8E0774761D2', '432193B78951FC98'],
    ['43297FAD38E373FE', '762514B829BF486A', '13F04154D69D1AE5'],
    ['07A7137045DA2A16', '3BDD119049372802', '2EEDDA93FFD39C79'],
    ['04689104C2FD3B2F', '26955F6835AF609A', 'D887E0393C2DA6E3'],
    ['37D06BB516CB7546', '164D5E404F275232', '5F99D04F5B163969'],
    ['1F08260D1AC2465E', '6B056E18759F5CCA', '4A057A3B24D3977B'],
    ['584023641ABA6176', '004BD6EF09176062', '452031C1E4FADA8E'],
    ['025816164629B007', '480D39006EE762F2', '7555AE39F59B87BD'],
    ['49793EBC79B3258F', '437540C8698F3CFA', '53C55F9CB49FC019'],
    ['4FB05E1515AB73A7', '072D43A077075292', '7A8E7BFA937E89A3'],
    ['49E95D6D4CA229BF', '02FE55778117F12A', 'CF9C5D7A4986ADB5'],
    ['018310DC409B26D6', '1D9D5C5018F728C2', 'D1ABB290658BC778'],
    ['1C587F1C13924FEF', '305532286D6F295A', '55CB3774D13EF201'],
    ['0101010101010101', '0123456789ABCDEF', 'FA34EC4847B268B2'],
    ['1F1F1F1F0E0E0E0E', '0123456789ABCDEF', 'A790795108EA3CAE'],
    ['E0FEE0FEF1FEF1FE', '0123456789ABCDEF', 'C39E072D9FAC631D'],
    ['0000000000000000', 'FFFFFFFFFFFFFFFF', '014933E0CDAFF6E4'],
    ['FFFFFFFFFFFFFFFF', '0000000000000000', 'F21E9A77B71C49BC'],
    ['0123456789ABCDEF', '0000000000000000', '245946885754369A'],
    ['FEDCBA9876543210', 'FFFFFFFFFFFFFFFF', '6B5C5A9C5D9E0A5A']
];

test("Eric Young's ECB vectors encrypt and decrypt", () => {
    for (const [key, plain, cipher] of ECB) {
        const bf = new Blowfish(hex(key));
        const block = hex(plain);
        bf.encryptBlock(block);
        assert.equal(toHex(block), cipher, `encrypt ${plain} with ${key}`);
        bf.decryptBlock(block);
        assert.equal(toHex(block), plain, `decrypt ${cipher} with ${key}`);
    }
});

test("Eric Young's CBC vector, with a 16-byte key like Deezer's", () => {
    const bf = new Blowfish(hex('0123456789ABCDEFF0E1D2C3B4A59687'));
    const iv = hex('FEDCBA9876543210');
    const data = new Uint8Array(32);
    data.set(Buffer.from('7654321 Now is the time for ', 'ascii'));
    const plain = data.slice();
    bf.encryptCbc(data, iv);
    assert.equal(toHex(data), '6B77B4D63006DEE605B156E27403979358DEB9E7154616D959F1652BD5FF92CC');
    bf.decryptCbc(data, iv);
    assert.deepEqual(data, plain);
});

// OpenSSL 3 keeps Blowfish in its legacy provider, which the openssl command
// can load even though Node cannot. Skipped where it is missing.
function openssl(mode: 'bf-cbc' | 'bf-ecb', key: Uint8Array, iv: Uint8Array | null, input: Uint8Array): Uint8Array | null {
    const args = ['enc', `-${mode}`, '-nopad', '-K', Buffer.from(key).toString('hex')];
    if (iv) args.push('-iv', Buffer.from(iv).toString('hex'));
    args.push('-provider', 'legacy', '-provider', 'default');
    const run = spawnSync('openssl', args, { input: Buffer.from(input) });
    return run.status === 0 ? Uint8Array.from(run.stdout) : null;
}
const hasOpenSSLBlowfish = openssl('bf-ecb', new Uint8Array(16), null, new Uint8Array(8)) !== null;

test('the ECB vectors agree with openssl', { skip: !hasOpenSSLBlowfish && 'openssl has no legacy Blowfish here' }, () => {
    for (const [key, plain, cipher] of ECB) {
        // openssl pads a short -K with zeros to 16 bytes, so give it the 8-byte
        // key twice, which Blowfish's key schedule (cycling the key) reads the same.
        const out = openssl('bf-ecb', hex(key + key), null, hex(plain));
        assert.equal(toHex(out!), cipher, `openssl, ${plain} with ${key}`);
    }
});

test('CBC over a 2048-byte block agrees with openssl both ways', { skip: !hasOpenSSLBlowfish && 'openssl has no legacy Blowfish here' }, () => {
    const key = crypto.randomBytes(16);
    const iv = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const plain = Uint8Array.from(crypto.randomBytes(2048));
    const theirs = openssl('bf-cbc', key, iv, plain)!;
    const ours = plain.slice();
    new Blowfish(key).encryptCbc(ours, iv);
    assert.deepEqual(ours, theirs);
    new Blowfish(key).decryptCbc(ours, iv);
    assert.deepEqual(ours, plain);
});

test('refuses what it cannot do', () => {
    assert.throws(() => new Blowfish(new Uint8Array(0)));
    assert.throws(() => new Blowfish(new Uint8Array(57)));
    const bf = new Blowfish(new Uint8Array(16));
    assert.throws(() => bf.decryptCbc(new Uint8Array(12), new Uint8Array(8)));
    assert.throws(() => bf.decryptCbc(new Uint8Array(16), new Uint8Array(4)));
});
