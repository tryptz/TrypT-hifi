// Thin client over the Qobuz-DL web app's HTTP API. The bot never calls Qobuz
// directly — it reuses the app's routes so all token/country/proxy handling and
// the signed file-proxy live in one place.

import { config } from './config.mjs';

function headers() {
    const h = { Accept: 'application/json' };
    if (config.tokenCountry) h['Token-Country'] = config.tokenCountry;
    return h;
}

async function getJson(path, params) {
    const url = new URL(config.appUrl + path);
    for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response;
    try {
        response = await fetch(url, { headers: headers() });
    } catch (error) {
        throw new Error(`Could not reach the Qobuz-DL app at ${config.appUrl}. Is it running? (${error.message})`);
    }
    let body;
    try {
        body = await response.json();
    } catch {
        throw new Error(`Unexpected non-JSON response from ${path} (HTTP ${response.status}).`);
    }
    if (!response.ok || body?.success === false) {
        const detail = Array.isArray(body?.error) ? body.error.map((e) => e.message).join(', ') : body?.error;
        throw new Error(detail || `Request to ${path} failed (HTTP ${response.status}).`);
    }
    return body.data;
}

export async function searchMusic(query, offset = 0) {
    return getJson('/api/get-music', { q: query, offset });
}

export async function getAlbum(albumId) {
    return getJson('/api/get-album', { album_id: albumId });
}

// Returns a signed, time-limited download URL served by the app's file proxy.
export async function getDownloadUrl(trackId, quality) {
    const data = await getJson('/api/download-music', { track_id: trackId, quality });
    return data?.url || null;
}

// HEAD the signed URL to learn the file size before deciding whether to upload
// it to Discord or hand back a link. Returns null if the size is unknown.
export async function probeSize(url) {
    try {
        const response = await fetch(url, { method: 'HEAD' });
        const length = response.headers.get('content-length');
        return length ? parseInt(length, 10) : null;
    } catch {
        return null;
    }
}
