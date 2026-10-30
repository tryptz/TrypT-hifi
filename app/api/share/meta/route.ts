import { NextRequest, NextResponse } from 'next/server';
import { getRequestOrigin } from '@/lib/file-proxy';
import { getShareMeta, parseShareTarget, PREVIEW_SIZE, verifyShareSignature } from '@/lib/share-server';

export const dynamic = 'force-dynamic';

// What tryptify.com puts in a shared link's Open Graph tags: the title, the
// artist, the cover, and this server's preview video. Open (Discord has no
// password), so it answers only links this server signed.
export async function GET(request: NextRequest) {
    const params = new URL(request.url).searchParams;
    try {
        const target = parseShareTarget(params);
        if (!verifyShareSignature(target, params.get('s'))) {
            return NextResponse.json({ success: false, error: 'Not a link this server made.' }, { status: 403, headers: { 'Access-Control-Allow-Origin': '*' } });
        }
        const meta = await getShareMeta(target);
        const preview = new URL('/api/share/preview', getRequestOrigin(request));
        params.forEach((value, key) => preview.searchParams.set(key, value));
        return NextResponse.json(
            { success: true, data: { ...meta, video: { url: preview.toString(), type: 'video/webm', width: PREVIEW_SIZE, height: PREVIEW_SIZE } } },
            { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } }
        );
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error?.message || 'Could not read this release.' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
}
