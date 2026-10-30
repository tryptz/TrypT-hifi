import { NextRequest, NextResponse } from 'next/server';
import { getShareMeta, getSharePreview, parseShareTarget, shareURL } from '@/lib/share-server';

export const dynamic = 'force-dynamic';

// A link that opens this release in Tryptify (lib/share-server.ts), signed so
// the open preview routes will answer for it. Behind the access password, like
// every other API route: only someone allowed to use this server can share.
export async function GET(request: NextRequest) {
    try {
        const target = parseShareTarget(new URL(request.url).searchParams);
        // Start the preview now: encoding takes a few seconds, and it should be
        // ready by the time the link is pasted into Discord. Failing here is fine;
        // /api/share/preview tries again when asked.
        getSharePreview(target).catch((error) => console.warn('Share preview not made yet:', error?.message || error));
        // The song's ISRC, title, artist and length go in the link, so a
        // listener without this service finds it on one they have. Without
        // them (the source didn't answer) the link still plays from this one.
        const meta = await getShareMeta(target).catch(() => undefined);
        return NextResponse.json({ success: true, data: { url: shareURL(target, meta) } });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error?.message || 'Could not make a share link.' }, { status: 400 });
    }
}
