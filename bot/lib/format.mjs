// Formatting helpers shared across bot commands.
// These mirror the logic in the web app's lib/qobuz-dl.tsx so embeds read the
// same way the site does, but re-implemented in plain ESM for the bot runtime.

const QUALITY_LABELS = {
    27: 'Hi-Res (up to 24-bit / 192 kHz) FLAC',
    7: 'Hi-Res (up to 24-bit / 96 kHz) FLAC',
    6: 'CD (16-bit / 44.1 kHz) FLAC',
    5: 'MP3 320 kbps'
};

export const QUALITY_CHOICES = [
    { name: 'Hi-Res 24/192 (FLAC)', value: '27' },
    { name: 'Hi-Res 24/96 (FLAC)', value: '7' },
    { name: 'CD 16/44.1 (FLAC)', value: '6' },
    { name: 'MP3 320', value: '5' }
];

export function qualityLabel(id) {
    return QUALITY_LABELS[id] || `Quality ${id}`;
}

export function qualityExtension(id) {
    return String(id) === '5' ? 'mp3' : 'flac';
}

// A track carries its album under `.album`; an album carries its own image.
export function getAlbum(input) {
    return input.image ? input : input.album;
}

export function formatTitle(input) {
    const base = input.title ?? input.name ?? 'Unknown';
    return `${base}${input.version ? ` (${input.version})` : ''}`.trim();
}

export function formatArtists(input, separator = ', ') {
    const album = getAlbum(input) || {};
    if (album.artists && album.artists.length > 0) {
        return album.artists.map((artist) => artist.name).join(separator);
    }
    return input.performer?.name || album.artist?.name || 'Various Artists';
}

// Qobuz cover URLs end in `_600.jpg`; swapping the size suffix for `org` yields
// the original full-resolution artwork.
export function getFullResImageUrl(input) {
    const album = getAlbum(input);
    const large = album?.image?.large;
    if (!large) return null;
    return large.substring(0, large.length - 7) + 'org.jpg';
}

export function getCoverUrl(input) {
    const album = getAlbum(input);
    return album?.image?.large || album?.image?.thumbnail || album?.image?.small || null;
}

export function formatDuration(seconds) {
    if (!seconds) return '0m';
    const totalMinutes = Math.floor(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const secs = Math.floor(seconds % 60);
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (hours <= 0 && secs > 0) parts.push(`${secs}s`);
    return parts.join(' ') || '0m';
}

// mm:ss for a single track row.
export function formatClock(seconds) {
    const total = Math.floor(seconds || 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatReleaseDate(input) {
    const album = getAlbum(input) || input;
    const iso = album.release_date_original;
    if (iso) return iso;
    if (album.released_at) return new Date(album.released_at * 1000).toISOString().slice(0, 10);
    return 'Unknown';
}

export function hiResBadge(input) {
    return input.hires ? '🎧 Hi-Res' : '💿 CD Quality';
}

export function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'track';
}

export function humanBytes(bytes) {
    if (!bytes || bytes < 0) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// Rough uncompressed-PCM size; FLAC typically lands ~50-70% of this, but it is
// a useful order-of-magnitude figure for "how big is this album" stats.
export function estimatePcmBytes(durationSeconds, bitDepth = 16, sampleRate = 44100, channels = 2) {
    return Math.round((durationSeconds || 0) * sampleRate * (bitDepth / 8) * channels);
}

// A tiny horizontal bar built from block characters, scaled to `max`.
export function bar(value, max, width = 12) {
    if (!max) return '';
    const filled = Math.max(1, Math.round((value / max) * width));
    return '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(0, width - filled));
}

export function truncate(text, max = 1024) {
    if (!text) return text;
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
