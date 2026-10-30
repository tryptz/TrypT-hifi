import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { getSharePreview, parseShareTarget, verifyShareSignature } from '@/lib/share-server';

export const dynamic = 'force-dynamic';
// ffmpeg needs Node, not the edge runtime.
export const runtime = 'nodejs';

// The preview Discord plays for a shared link: the cover as one still frame
// and a 30-second clip in Opus at 256 kbps, as WebM (lib/share-server.ts).
// Open, for signed links only. Made once, then served from disk.
export async function GET(request: NextRequest) {
    const params = new URL(request.url).searchParams;
    try {
        const target = parseShareTarget(params);
        if (!verifyShareSignature(target, params.get('s'))) {
            return NextResponse.json({ success: false, error: 'Not a link this server made.' }, { status: 403 });
        }
        const file = await getSharePreview(target);
        const { size } = await fs.promises.stat(file);
        return new NextResponse(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
            headers: {
                'Content-Type': 'video/webm',
                'Content-Length': String(size),
                // The same link always means the same clip.
                'Cache-Control': 'public, max-age=31536000, immutable',
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error?.message || 'Could not make a preview.' }, { status: 404 });
    }
}
