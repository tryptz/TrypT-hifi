import fs from 'node:fs';
import axios from 'axios';
import { cacheFilePath, ttlSeconds } from './apple-file-cache';

// ---------------------------------------------------------------------------
// Decrypt-on-demand. When an Apple track isn't in the cloud cache yet, ask the
// home "decrypt agent" (a small service on the tailnet — see amd/decrypt-agent.mjs)
// to run the downloader, which decrypts via the local wrapper and uploads the
// resulting <adamId>.m4a back to /api/apple/files/<adamId>.
//
// Fire-and-forget: the agent acks immediately (202) and does the slow decrypt in
// the background, so we never block the manifest response. Opt-in via
// APPLE_DECRYPT_AGENT; reached through the Tailscale SOCKS proxy on Railway.
// ---------------------------------------------------------------------------

let SocksProxyAgent: typeof import('socks-proxy-agent').SocksProxyAgent | undefined;
if (typeof window === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
}

export async function triggerDecryptIfMissing(adamId: string, quality: string): Promise<void> {
    const agent = process.env.APPLE_DECRYPT_AGENT; // e.g. http://100.80.88.106:8790
    if (!agent) return;

    // Already cached (and fresh)? Nothing to do.
    try {
        const st = await fs.promises.stat(cacheFilePath(adamId));
        if (Date.now() - st.mtimeMs < ttlSeconds() * 1000) return;
    } catch {
        // not cached — fall through and trigger the agent
    }

    const socks = process.env.APPLE_WRAPPER_SOCKS5;
    const proxyAgent = socks && SocksProxyAgent ? new SocksProxyAgent('socks5h://' + socks.replace(/^socks5?:\/\//i, '')) : undefined;

    try {
        await axios.post(
            `${agent.replace(/\/+$/, '')}/decrypt`,
            { adamId, quality },
            {
                headers: { 'X-Agent-Secret': process.env.APPLE_DECRYPT_SECRET || '', 'Content-Type': 'application/json' },
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent,
                timeout: Number(process.env.APPLE_DECRYPT_TIMEOUT_MS) || 8000
            }
        );
    } catch (error) {
        // Agent unreachable / already busy: harmless — the caller still gets the
        // manifest, and a later retry will re-trigger.
        console.warn(`[apple-decrypt] trigger failed for ${adamId}:`, error instanceof Error ? error.message : error);
    }
}
