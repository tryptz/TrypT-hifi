import { NextRequest, NextResponse } from 'next/server';
import { getJob, markDelivered } from '@/lib/apple-job-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Tryptify calls this after opening the deep link (or scanning the QR) to pull
// the full manifest(s) for a job. Fetching marks the job delivered so it drops
// off the REST pull queue.
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const job = getJob(token);
    if (!job) {
        return new NextResponse(JSON.stringify({ success: false, error: 'Job not found or expired' }), { status: 404 });
    }
    markDelivered(token);
    return new NextResponse(
        JSON.stringify({ success: true, data: { jobId: job.jobId, createdAt: job.createdAt, manifests: job.manifests } }),
        { status: 200 }
    );
}
