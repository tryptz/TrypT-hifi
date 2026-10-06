import { NextRequest, NextResponse } from 'next/server';
import { HifiError, hifiApi, nativeTidalConfigured } from './tidal-native-server';

// Route handler for one HiFi API path (app/search/route.ts serves '/search/', ...),
// so Tryptify can add this site as its TIDAL server. Bodies and errors match
// hifi-api's: the JSON a real instance sends, or { detail } with its status.
// Only the deployment's own TIDAL account answers these; without one they 503
// (this site does not relay an external TIDAL_API_BASE instance).
export function hifiRoute(path: string) {
    return async function GET(request: NextRequest) {
        try {
            if (!nativeTidalConfigured())
                throw new HifiError(503, 'TIDAL is not configured on this server: set TIDAL_CLIENT_ID, TIDAL_CLIENT_SECRET and TIDAL_REFRESH_TOKEN.');
            return NextResponse.json(await hifiApi(path, request.nextUrl.searchParams));
        } catch (error) {
            if (error instanceof HifiError) return NextResponse.json({ detail: error.message }, { status: error.status });
            console.error(`[tidal] ${path}`, error);
            return NextResponse.json({ detail: 'Internal Server Error' }, { status: 500 });
        }
    };
}
