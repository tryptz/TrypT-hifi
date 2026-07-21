import { NextRequest, NextResponse } from 'next/server';
import { createJob } from '@/lib/apple-job-store';
import { getRequestOrigin } from '@/lib/file-proxy';
import { DownloadJobManifest } from '@/lib/apple-music';
import QRCode from 'qrcode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HANDOFF_SCHEME = () => process.env.APPLE_HANDOFF_SCHEME || 'tryptify';

// Create a download job from one or more manifests and return the handoff
// payload: a signed deep link (for tryptify:// on the same device or a QR scan
// from desktop) plus the fetch URL Tryptify uses to pull the manifests. The job
// is also placed on the REST pull queue (GET /api/apple/jobs).
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const manifests: DownloadJobManifest[] = Array.isArray(body?.manifests) ? body.manifests : [];
        if (manifests.length === 0) {
            return new NextResponse(JSON.stringify({ success: false, error: 'No manifests provided' }), { status: 400 });
        }

        const job = createJob(manifests);
        const origin = getRequestOrigin(request);
        const fetchUrl = `${origin}/api/apple/job/${job.token}`;
        const deepLink = `${HANDOFF_SCHEME()}://job?token=${job.token}&url=${encodeURIComponent(fetchUrl)}`;
        const qrSvg = await QRCode.toString(deepLink, { type: 'svg', margin: 1, width: 240 });
        const qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(qrSvg, 'utf8').toString('base64')}`;

        return new NextResponse(
            JSON.stringify({
                success: true,
                data: { jobId: job.jobId, token: job.token, deepLink, fetchUrl, qrDataUrl, trackCount: manifests.length }
            }),
            { status: 200 }
        );
    } catch (error: any) {
        return new NextResponse(
            JSON.stringify({ success: false, error: error?.message || 'An error occurred creating the job.' }),
            { status: 400 }
        );
    }
}
