import crypto from 'node:crypto';
import { DownloadJobManifest } from './apple-music';

// ---------------------------------------------------------------------------
// In-memory store for Apple download-job manifests (the trypt-hifi -> Tryptify
// handoff). Two delivery paths share the store:
//   1. Deep link / QR  -> Tryptify opens tryptify://job?token=... then GETs
//      /api/apple/job/<token> to fetch the manifests.
//   2. REST pull queue -> Tryptify polls /api/apple/jobs and drains pending jobs.
//
// Server-only. This is a single-instance store with a TTL; swap for a shared
// store (Redis/DB) if you deploy multiple instances. Do NOT import into client.
// ---------------------------------------------------------------------------

export type AppleJob = {
    jobId: string;
    token: string;
    manifests: DownloadJobManifest[];
    createdAt: number;
    delivered: boolean;
};

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

// Persist across hot-reloads / route module reinstantiation in dev.
const globalStore = globalThis as unknown as { __appleJobs?: Map<string, AppleJob> };
const jobs: Map<string, AppleJob> = globalStore.__appleJobs || (globalStore.__appleJobs = new Map());

function sweep() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [token, job] of Array.from(jobs.entries())) {
        if (job.createdAt < cutoff) jobs.delete(token);
    }
}

export function createJob(manifests: DownloadJobManifest[]): AppleJob {
    sweep();
    const token = crypto.randomBytes(24).toString('base64url');
    const jobId = crypto.randomUUID();
    const job: AppleJob = { jobId, token, manifests, createdAt: Date.now(), delivered: false };
    jobs.set(token, job);
    return job;
}

export function getJob(token: string): AppleJob | null {
    sweep();
    return jobs.get(token) || null;
}

export function markDelivered(token: string): void {
    const job = jobs.get(token);
    if (job) job.delivered = true;
}

// Pending jobs for the REST pull queue (not yet fetched by a device).
export function listPending(): AppleJob[] {
    sweep();
    return Array.from(jobs.values())
        .filter((job) => !job.delivered)
        .sort((a, b) => a.createdAt - b.createdAt);
}
