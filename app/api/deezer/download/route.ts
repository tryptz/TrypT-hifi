import { NextRequest, NextResponse } from 'next/server';
import { checkDeezerTrackAvailability, getDeezerDownloadFile } from '@/lib/deezer-dl-server';
import z from 'zod';

// Parameters schema. Kept module-private: a Next.js route file may only export
// HTTP handlers and route config, so exporting this fails the build.
const downloadParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric'),
    quality: z.enum(['5', '7', '6', '27']).default('27')
});

export async function GET(request: NextRequest) {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    
    try {
        const { track_id, quality } = downloadParamsSchema.parse(params);
        
        // First check availability
        const availability = await checkDeezerTrackAvailability(track_id, {});
        
        if (!availability.available_qualities.flac && !availability.available_qualities.mp3_320) {
            return new NextResponse(
                JSON.stringify({
                    success: false,
                    error: 'Track is not available for download with current ARL cookie.'
                }),
                { status: 403 }
            );
        }
        
        // Fetch track info (already have availability metadata; use it for the title)
        const trackInfo = availability;
        
        if (!trackInfo) {
            return new NextResponse(
                JSON.stringify({
                    success: false,
                    error: 'Track not found'
                }),
                { status: 404 }
            );
        }
        
        // Deezer falls back on its own (FLAC_24 -> FLAC -> MP3) to the best file
        // this track has, and says which one it served.
        const { url: downloadUrl, format } = await getDeezerDownloadFile(track_id, quality);

        if (!downloadUrl) {
            return new NextResponse(
                JSON.stringify({
                    success: false,
                    error: 'Could not generate download URL for this track.'
                }),
                { status: 502 }
            );
        }

        return new NextResponse(
            JSON.stringify({
                success: true,
                data: {
                    url: downloadUrl,
                    quality: format,
                    track_id: track_id,
                    title: availability.title || undefined
                }
            }),
            { status: 200 }
        );
    } catch (error: any) {
        console.error('Deezer download error:', error);
        return new NextResponse(
            JSON.stringify({
                success: false,
                error: error.message || 'Internal server error'
            }),
            { status: 500 }
        );
    }
}