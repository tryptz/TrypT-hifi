// One password for the whole deployment: ACCESS_PASSWORD. When it is set,
// every page and API route needs it (middleware.ts); when it is not, the site
// is open, as before.
//
// It travels three ways, because not every caller can send a header:
// - the X-Access-Key header, from Tryptify (the app and its web player) and the bot;
// - the access_key query parameter, for links an <audio> element or a media
//   player fetches by itself (/api/tidal/stream-file, /api/tidal/atmos-file);
// - the trypt_access cookie, set by /unlock for this site's own pages, which
//   holds a hash of the password, never the password.

export const ACCESS_HEADER = 'x-access-key';
export const ACCESS_QUERY = 'access_key';
export const ACCESS_COOKIE = 'trypt_access';

export function accessPassword(): string | null {
    const password = process.env.ACCESS_PASSWORD?.trim();
    return password ? password : null;
}

// SHA-256 of the password, as hex: the cookie's value, and what every check
// compares, so the comparison is always between two strings of one length.
export async function accessDigest(password: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`trypt-hifi-access:${password}`));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant time for equal lengths, which two digests always are.
export function sameDigest(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
