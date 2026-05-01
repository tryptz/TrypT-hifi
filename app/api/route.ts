import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ENDPOINTS = [
    {
        path: '/api/get-music',
        method: 'GET',
        description: 'Search Qobuz for tracks, albums and artists.',
        params: {
            q: 'string (required) - search query',
            offset: 'integer (optional, 0-1000, default 0)'
        },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-album',
        method: 'GET',
        description: 'Get full album metadata + track list.',
        params: { album_id: 'string (required)' },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-artist',
        method: 'GET',
        description: 'Get artist metadata.',
        params: { artist_id: 'string (required)' },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-releases',
        method: 'GET',
        description: 'List releases for an artist.',
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
        description: 'Resolve a streamable/download URL for a track.',
        params: {
            track_id: 'integer (required)',
            quality: "'27' (Hi-Res 24-bit) | '7' (24-bit/96k) | '6' (16-bit FLAC) | '5' (MP3 320), default '27'"
        },
        headers: { 'Token-Country': 'optional ISO country code' }
    },
    {
        path: '/api/get-countries',
        method: 'GET',
        description: 'List ISO country codes supported by the configured Qobuz tokens.',
        params: {},
        headers: {}
    }
];

export async function GET(_request: NextRequest) {
    return NextResponse.json({
        success: true,
        data: {
            name: 'TrypT Hifi DL',
            description: 'Qobuz HiFi proxy / instance API.',
            version: '1.0.0',
            cors: 'enabled, all origins',
            endpoints: ENDPOINTS
        }
    });
}
