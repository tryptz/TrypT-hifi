import { NextRequest, NextResponse } from 'next/server';
import { hasTokens } from '@/lib/token-store';

export const dynamic = 'force-dynamic';

// Self-describing instance / health index.
//
// This endpoint exists so a remote client — primarily the monotrypt.android
// (Tryptify) Android app, which uses a user-configured "trypt-hifi instance"
// as its Qobuz backend — can discover this server, confirm it is ready, and
// learn its capabilities. It also backs the "Instance Mode" panel in Settings.
//
// Returns only booleans about credential/token state — never the token itself.
//
// (Restored after it was dropped in fe99156; the Android app's InstanceManager
// and HiFiApiClient are built against exactly these /api/* routes.)

const INSTANCE_NAME = process.env.NEXT_PUBLIC_APPLICATION_NAME || 'TrypT Hifi';

// Version of the instance API contract this server speaks (not the app version).
const INSTANCE_API_VERSION = '1.1.0';

const ENDPOINTS = [
    {
        path: '/api/get-music',
        method: 'GET',
        description: 'Search Qobuz for tracks, albums and artists.',
        params: {
            q: 'string (required) - search query (or a play.qobuz.com album/track/artist URL)',
            offset: 'integer (optional, 0-1000, default 0)'
        },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-album',
        method: 'GET',
        description: 'Get full album metadata + track list (data.tracks.items[]).',
        params: { album_id: 'string (required) - album slug/UPC id from search results' },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-artist',
        method: 'GET',
        description: 'Get artist metadata (data.artist: name.display, images.portrait, top_tracks[], similar_artists).',
        params: { artist_id: 'string (required) - numeric artist id' },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-releases',
        method: 'GET',
        description: "List releases for an artist.",
        params: {
            artist_id: 'string (required)',
            release_type: "'album' | 'live' | 'compilation' | 'epSingle' | 'download' (default 'album')",
            limit: 'integer (default 10)',
            offset: 'integer (default 0)',
            track_size: 'integer (default 1000)'
        },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/download-music',
        method: 'GET',
        description: 'Resolve a streamable/download URL for a track (data.url is a signed Qobuz CDN URL).',
        params: {
            track_id: 'integer (required)',
            quality: "'27' (Hi-Res 24/192) | '7' (24/96) | '6' (16-bit FLAC) | '5' (MP3 320), default '27'"
        },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-countries',
        method: 'GET',
        description: 'List ISO country codes supported by the configured Qobuz tokens (static map; may be empty).',
        params: {},
        headers: {}
    }
];

// Resolve the externally-visible base URL. Behind a reverse proxy / tunnel the
// real Host is the proxy-supplied X-Forwarded-Host; fall back to Host.
function baseUrl(request: NextRequest): string {
    const proto = request.headers.get('x-forwarded-proto') || 'http';
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    return host ? `${proto}://${host}` : '';
}

export async function GET(request: NextRequest) {
    const appCredentials = Boolean(process.env.QOBUZ_APP_ID && process.env.QOBUZ_SECRET && process.env.QOBUZ_API_BASE);
    const tokens = hasTokens();
    const ready = appCredentials && tokens;
    const base = baseUrl(request);

    return NextResponse.json({
        success: true,
        data: {
            name: INSTANCE_NAME,
            description: 'Qobuz HiFi proxy / instance API for the Tryptify (monotrypt.android) app and compatible clients.',
            version: INSTANCE_API_VERSION,
            instanceMode: true,
            ready,
            // Boolean-only readiness signal (no secrets). `ready` means this
            // instance can serve catalog + download requests right now.
            health: {
                appCredentials,
                tokens,
                ready
            },
            cors: 'enabled, all origins',
            // How to point the Android app at this server.
            client: {
                app: 'monotrypt.android (Tryptify)',
                repo: 'https://github.com/tryptz/monotrypt.android',
                setting: 'Settings → Instances → Qobuz URL',
                qobuzInstanceUrl: base
            },
            endpoints: ENDPOINTS
        }
    });
}
