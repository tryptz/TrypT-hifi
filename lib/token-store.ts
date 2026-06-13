import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Server-only runtime store for Qobuz user auth tokens.
// Do not import this file into the client.
//
// Persistence model:
//   - An in-memory cache gives instant, live effect (no server restart needed
//     after adding/removing a token).
//   - A gitignored JSON file (data/tokens.json by default) survives restarts.
//   - On cold start the cache is seeded from the JSON file if present,
//     otherwise from process.env.QOBUZ_AUTH_TOKENS (the .env value is now just
//     a one-time seed; the runtime store is authoritative).

export type StoredToken = {
    token: string;
    label?: string; // email or "pasted" — never a password
    country?: string | null;
    addedAt: number;
};

export type MaskedToken = {
    id: string; // stable hash of the token — safe to expose to the client
    masked: string;
    label?: string;
    country?: string | null;
    addedAt: number;
};

const DATA_DIR = process.env.TOKEN_STORE_DIR || path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'tokens.json');

let cache: StoredToken[] | null = null; // null = not yet loaded

export function tokenId(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function maskToken(token: string): string {
    if (token.length <= 8) return '••••';
    return token.slice(0, 4) + '…' + token.slice(-4);
}

function seedFromEnv(): StoredToken[] {
    const raw = process.env.QOBUZ_AUTH_TOKENS;
    if (!raw) return [];
    let arr: string[];
    try {
        const parsed = JSON.parse(raw);
        arr = Array.isArray(parsed) ? parsed : [raw];
    } catch {
        arr = [raw];
    }
    return arr
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
        .map((token) => ({ token, label: 'env', country: null, addedAt: 0 }));
}

function load(): StoredToken[] {
    if (cache) return cache;
    try {
        const buf = fs.readFileSync(STORE_PATH, 'utf-8');
        const json = JSON.parse(buf);
        cache = Array.isArray(json?.tokens) ? json.tokens : [];
    } catch {
        cache = seedFromEnv(); // file missing/corrupt -> env fallback
    }
    return cache!;
}

function persist(): void {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify({ tokens: cache }, null, 2), 'utf-8');
    } catch (e) {
        // Never throw: the in-memory cache still works for this process lifetime.
        // Log without leaking any secret material.
        console.error('token-store: failed to persist tokens.json:', (e as Error).message);
    }
}

export function getTokens(): StoredToken[] {
    return load();
}

export function hasTokens(): boolean {
    return load().length > 0;
}

export function getRandomPoolToken(): string | undefined {
    const tokens = load();
    if (tokens.length === 0) return undefined;
    return tokens[Math.floor(Math.random() * tokens.length)].token;
}

export function addToken(entry: { token: string; label?: string; country?: string | null }): MaskedToken {
    const tokens = load();
    const existing = tokens.find((x) => x.token === entry.token);
    if (existing) {
        // Refresh the label if a more meaningful one is provided (e.g. email over "pasted").
        if (entry.label && existing.label !== entry.label) {
            existing.label = entry.label;
            persist();
        }
        return toMasked(existing);
    }
    const stored: StoredToken = {
        token: entry.token,
        label: entry.label,
        country: entry.country ?? null,
        addedAt: Date.now()
    };
    tokens.push(stored);
    cache = tokens;
    persist();
    return toMasked(stored);
}

export function setTokens(entries: StoredToken[]): void {
    cache = entries;
    persist();
}

export function removeToken(id: string): boolean {
    const tokens = load();
    const next = tokens.filter((x) => tokenId(x.token) !== id);
    const changed = next.length !== tokens.length;
    cache = next;
    if (changed) persist();
    return changed;
}

function toMasked(x: StoredToken): MaskedToken {
    return {
        id: tokenId(x.token),
        masked: maskToken(x.token),
        label: x.label,
        country: x.country ?? null,
        addedAt: x.addedAt
    };
}

export function getMaskedTokens(): MaskedToken[] {
    return load().map(toMasked);
}
