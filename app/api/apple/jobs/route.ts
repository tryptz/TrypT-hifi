import { NextRequest, NextResponse } from 'next/server';
import { listPending } from '@/lib/apple-job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// REST pull queue: Tryptify polls this to discover pending jobs (album/artist
// batches). Optionally gated by APPLE_JOB_QUEUE_TOKEN (Bearer) so only your
// device can drain the queue. Fetching a job's manifests (via /api/apple/job/
// <token>) removes it from this list.
export async function GET(request: NextRequest) {
    const required = process.env.APPLE_JOB_QUEUE_TOKEN;
    if (required) {
        const auth = request.headers.get('authorization') || '';
        if (auth !== `Bearer ${required}`) {
            return new NextResponse(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 });
        }
    }
    const pending = listPending().map((job) => ({
        jobId: job.jobId,
        token: job.token,
        createdAt: job.createdAt,
        trackCount: job.manifests.length,
        fetchUrl: `/api/apple/job/${job.token}`
    }));
    return new NextResponse(JSON.stringify({ success: true, data: { jobs: pending } }), { status: 200 });
}
