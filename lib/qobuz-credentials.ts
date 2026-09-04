import axios from 'axios';

// Functions only to be used by servers
// Do not import this file into the client

// ---------------------------------------------------------------------------
// Qobuz API credentials (app id + request-signing secrets).
//
// Why this exists: Qobuz ships its app id and its request-signing secrets inside
// the web player's JS bundle, and rotates them whenever it cuts a new bundle.
// Pinning them in QOBUZ_APP_ID/QOBUZ_SECRET therefore has a shelf life, and when
// it expires the failure is *partial and confusing*: catalog/search, album/get
// and artist/page authenticate with the app id and the user token alone, so
// browsing keeps working, while track/getFileUrl — the only call that carries an
// md5 `request_sig` derived from the secret — starts getting rejected. The app
// looks healthy right up until you press download.
//
// So the secret is resolved at runtime instead: env still wins (a deployment can
// pin known-good values), but when the signed call is rejected we re-read the
// live bundle and retry. That turns a manual outage into a self-healing one.
//
// The bundle is ~9 MB, so it is fetched at most once per TTL per instance, only
// ever on demand, and concurrent callers share a single in-flight fetch.
// ---------------------------------------------------------------------------

const LOGIN_URL = 'https://play.qobuz.com/login';
const BUNDLE_ORIGIN = 'https://play.qobuz.com';
const BUNDLE_PATH_REGEX = /<script src="(\/resources\/[\d.]+-[a-z]\d+\/bundle\.js)"/;
const APP_ID_REGEX = /production:\{api:\{appId:"(\d+)",appSecret:"(\w+)"/;

// The signing secrets are not stored verbatim. Each is split into a `seed` (next
// to a timezone name) and an `info`/`extras` pair (in the timezone table); the
// three concatenated, minus a 44-char tail, base64-decode to the real secret.
const SEED_TIMEZONE_REGEX = /[a-z]\.initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)/g;
const INFO_EXTRAS_REGEX = /name:"\w+\/([A-Z][a-z]+)",info:"([\w=]+)",extras:"([\w=]+)"/g;

const BUNDLE_TTL_MS = 12 * 60 * 60 * 1000;
const BUNDLE_TIMEOUT_MS = 45_000;
const REFRESH_COOLDOWN_MS = 60_000;

export type QobuzCredentials = {
    appId: string;
    // Ordered candidates. Qobuz publishes several and only some are live, so the
    // caller tries them in turn and promotes whichever one signs successfully.
    secrets: string[];
    source: 'env' | 'bundle';
};

let cached: QobuzCredentials | null = null;
let cachedAt = 0;
let inFlight: Promise<QobuzCredentials> | null = null;

let SocksProxyAgent: typeof import('socks-proxy-agent').SocksProxyAgent | undefined;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

export function makeProxyAgent() {
    if (!process.env.SOCKS5_PROXY || !SocksProxyAgent) return undefined;
    return new SocksProxyAgent('socks5://' + process.env.SOCKS5_PROXY);
}

async function fetchText(url: string): Promise<string> {
    const proxyAgent = makeProxyAgent();
    const response = await axios.get<string>(url, {
        // The bundle is served as JS; force text so axios never tries to parse it.
        responseType: 'text',
        transformResponse: [(data) => data],
        timeout: BUNDLE_TIMEOUT_MS,
        maxContentLength: 64 * 1024 * 1024,
        headers: {
            // Qobuz serves the player shell only to browser-shaped clients.
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent
    });
    return response.data;
}

// Exported for testing: pulls every candidate secret out of a bundle body.
export function extractSecrets(bundle: string): string[] {
    // Fresh instances: the module-level literals are global, and sharing their
    // lastIndex across calls would make the second call skip matches.
    const seedRe = new RegExp(SEED_TIMEZONE_REGEX.source, 'g');
    const infoRe = new RegExp(INFO_EXTRAS_REGEX.source, 'g');

    const seeds = new Map<string, string>();
    let seedMatch: RegExpExecArray | null;
    while ((seedMatch = seedRe.exec(bundle)) !== null) {
        seeds.set(seedMatch[2].toLowerCase(), seedMatch[1]);
    }

    const secrets: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = infoRe.exec(bundle)) !== null) {
        const [, timezone, info, extras] = match;
        const seed = seeds.get(timezone.toLowerCase());
        // The timezone table lists more zones than there are seeds; only the
        // zones that carry a seed produce a secret.
        if (!seed) continue;
        const joined = seed + info + extras;
        if (joined.length <= 44) continue;
        const decoded = Buffer.from(joined.slice(0, -44), 'base64').toString('utf8');
        // A real secret is a 32-char hex string; anything else means the bundle
        // layout moved and this match is noise.
        if (/^[0-9a-f]{32}$/i.test(decoded) && !secrets.includes(decoded)) secrets.push(decoded);
    }
    return secrets;
}

export function extractAppId(bundle: string): { appId: string; appSecret: string } | null {
    const match = bundle.match(APP_ID_REGEX);
    if (!match) return null;
    return { appId: match[1], appSecret: match[2] };
}

async function scrapeBundle(): Promise<QobuzCredentials> {
    const login = await fetchText(LOGIN_URL);
    const bundlePath = login.match(BUNDLE_PATH_REGEX)?.[1];
    if (!bundlePath) throw new Error('Qobuz credentials: could not locate the web-player bundle on play.qobuz.com.');

    const bundle = await fetchText(BUNDLE_ORIGIN + bundlePath);
    const app = extractAppId(bundle);
    if (!app) throw new Error(`Qobuz credentials: no app id found in ${bundlePath}.`);

    const secrets = extractSecrets(bundle);
    // appSecret sits next to the app id and is occasionally the live signing key,
    // so keep it as a last-resort candidate behind the timezone-derived ones.
    if (app.appSecret && !secrets.includes(app.appSecret)) secrets.push(app.appSecret);
    if (secrets.length === 0) throw new Error(`Qobuz credentials: no signing secrets found in ${bundlePath}.`);

    return { appId: app.appId, secrets, source: 'bundle' };
}

function credentialsFromEnv(): QobuzCredentials | null {
    const appId = process.env.QOBUZ_APP_ID;
    const secret = process.env.QOBUZ_SECRET;
    if (!appId || !secret) return null;
    return { appId, secrets: [secret], source: 'env' };
}

/**
 * Current credentials. Env-pinned values are returned as-is; otherwise the live
 * bundle is scraped and cached. Never throws for a *missing* env var — only if
 * the bundle itself cannot be read.
 */
export async function resolveCredentials(): Promise<QobuzCredentials> {
    if (cached && Date.now() - cachedAt < BUNDLE_TTL_MS) return cached;

    const fromEnv = credentialsFromEnv();
    if (fromEnv) {
        cached = fromEnv;
        cachedAt = Date.now();
        return fromEnv;
    }
    return refreshCredentials();
}

/**
 * App id only, for the browse calls (search / album / artist) that authenticate
 * with the app id and the user token and never sign anything. Kept separate so a
 * deployment that pins QOBUZ_APP_ID never pays for a bundle fetch just to search.
 */
export async function resolveAppId(): Promise<string> {
    // If a refresh has already happened, the pinned value was rotated out and the
    // bundle's app id is the better one — browse should not keep using the stale
    // pin while downloads have moved on.
    if (cached?.source === 'bundle') return cached.appId;
    if (process.env.QOBUZ_APP_ID) return process.env.QOBUZ_APP_ID;
    return (await resolveCredentials()).appId;
}

/**
 * Force a re-read of the live bundle, ignoring both the cache and env. Called
 * when a signed request is rejected, which is the signal that whatever we were
 * using has been rotated out.
 */
export async function refreshCredentials(): Promise<QobuzCredentials> {
    // Collapse concurrent refreshes: a burst of downloads must not each pull 9 MB.
    if (inFlight) return inFlight;
    // And rate-limit sequential ones. Without this, a track that fails for a
    // reason other than rotation (an unstreamable region, say) would re-scrape
    // on every retry the user makes.
    if (cached?.source === 'bundle' && Date.now() - cachedAt < REFRESH_COOLDOWN_MS) return cached;
    inFlight = scrapeBundle()
        .then((creds) => {
            cached = creds;
            cachedAt = Date.now();
            return creds;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

/**
 * Promote the secret that actually signed a successful request so subsequent
 * downloads try it first instead of re-walking the candidate list.
 */
export function promoteSecret(secret: string): void {
    if (!cached) return;
    const rest = cached.secrets.filter((s) => s !== secret);
    cached = { ...cached, secrets: [secret, ...rest] };
}

// Test seam: drop all cached state.
export function resetCredentialsCache(): void {
    cached = null;
    cachedAt = 0;
    inFlight = null;
}
