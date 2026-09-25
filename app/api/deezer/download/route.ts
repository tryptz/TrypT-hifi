import { NextRequest, NextResponse } from 'next/server';
import { getDeezerTrackInfo, checkDeezerTrackAvailability } from '@/lib/deezer-dl-server';
import z from 'zod';

// Parameters schema
export const downloadParamsSchema = z.object({
    track_id: z.string().regex(/^\d+$/, 'ID must be numeric'),
    quality: z.enum(['5', '7', '6', '27']).default('27')
});

// Response schema
export const downloadResponseSchema = z.object({
    success: z.boolean().optional(),
    data: z.union(
        z.object({
            url: z.string(),
            quality: z.number()
        }),
        z.array(z.object({
            track_id: z.string(),
            quality: z.number(),
            url: z.string()
        }))
    )
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
        
        // Fetch track info
        const trackInfo = await getDeezerTrackInfo(track_id, {});
        
        if (!trackInfo) {
            return new NextResponse(
                JSON.stringify({
                    success: false,
                    error: 'Track not found'
                }),
                { status: 404 }
            );
        }
        
        // Build download URL based on quality
        const qualityMap = {
            '5': 1,   // MP3 128
            '7': 3,   // MP3 320
            '6': 9,   // FLAC
            '27': 9   // FLAC
        };
        const qualityLevel = qualityMap[quality];
        
        // Determine best quality available
        let bestQuality = quality;
        if (qualityLevel === 9 && trackInfo.available_qualities.flac) {
            bestQuality = 9;
        } else if (qualityLevel === 3 && trackInfo.available_qualities.mp3_320) {
            bestQuality = 3;
        }
        
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
        
        return new NextResponse(
            JSON.stringify({
                success: true,
                data: {
                    url: downloadUrl,
                    quality: bestQuality,
                    track_id: track_id,
                    title: trackInfo.title
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