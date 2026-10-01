import { NextRequest, NextResponse } from 'next/server';
import { getDeezerTrackInfo, checkDeezerTrackAvailability, getDeezerDownloadURL, getDeezerTrackStreamData } from '@/lib/deezer-dl-server';
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
        
        // Fall back to the best quality this ARL can actually serve.
        // getDeezerDownloadURL maps these keys to Deezer's own levels (1/3/9).
        const { flac, mp3_320 } = availability.available_qualities;
        const wantsFlac = quality === '6' || quality === '27';
        let bestQuality = quality;
        if (wantsFlac && !flac) bestQuality = '7';
        if (bestQuality === '7' && !mp3_320) bestQuality = '5';
        
        const downloadUrl = await getDeezerDownloadURL(track_id, bestQuality);

        if (!downloadUrl) {
            return new NextResponse(
                JSON.stringify({
                    success: false,
                    error: 'Could not generate download URL for this track.'
                }),
                { status: 502 }
            );
        }

        const trackMeta = await getDeezerTrackStreamData(track_id);
        return new NextResponse(
            JSON.stringify({
                success: true,
                data: {
                    url: downloadUrl,
                    quality: bestQuality,
                    track_id: track_id,
                    title: (trackMeta.SNG_TITLE as string) || (availability as { title?: string })?.title || undefined
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