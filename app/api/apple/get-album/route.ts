import { NextRequest, NextResponse } from 'next/server';
import { getAlbumInfo } from '@/lib/apple-music-server';
import z from 'zod';

export const dynamic = 'force-dynamic';

const albumInfoParamsSchema = z.object({
    album_id: z.string().min(1, 'ID is required')
});

export async function GET(request: NextRequest) {
    const country = request.headers.get('Token-Country');
    const userToken = request.headers.get('Music-User-Token') || undefined;
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    try {
        const { album_id } = albumInfoParamsSchema.parse(params);
        const data = await getAlbumInfo(album_id, { ...(country ? { country } : {}), userToken });
        return new NextResponse(JSON.stringify({ success: true, data }), { status: 200 });
    } catch (error: any) {
        return new NextResponse(
            JSON.stringify({
                success: false,
                error: error?.errors || error.message || 'An error occurred parsing the request.'
            }),
            { status: 400 }
        );
    }
}
