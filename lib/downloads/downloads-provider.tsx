'use client';

// Reactive download-queue model. Replaces the old module-level `jobs` array +
// 100ms setInterval polling (lib/status-bar) with a proper per-job state machine
// that the UI can subscribe to: queued → active → processing → done | error |
// cancelled, with per-job progress, byte telemetry, history, cancel and retry.
//
// The actual download work (fetch → ffmpeg → blob → saveAs → optional library
// retention) lives in lib/download-job.tsx and is passed in as a `runner`. This
// provider only owns scheduling, state, and lifecycle.

import React, { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

export type DownloadStatus = 'queued' | 'active' | 'processing' | 'done' | 'error' | 'cancelled';

export type DownloadJob = {
    id: string;
    kind: 'track' | 'album';
    title: string;
    subtitle?: string;
    artworkUrl?: string;
    status: DownloadStatus;
    progress: number; // 0–100
    stage?: string; // human-readable current step
    bytesDone: number;
    bytesTotal: number;
    error?: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
};

/** Handle handed to a runner so it can report progress and observe cancellation. */
export type JobHandle = {
    id: string;
    signal: AbortSignal;
    update: (partial: Partial<Pick<DownloadJob, 'progress' | 'stage' | 'bytesDone' | 'bytesTotal' | 'status' | 'title' | 'subtitle' | 'artworkUrl'>>) => void;
    /** True once the job has been cancelled (abort requested). */
    isCancelled: () => boolean;
};

export type DownloadMeta = {
    kind: 'track' | 'album';
    title: string;
    subtitle?: string;
    artworkUrl?: string;
};

export type DownloadRunner = (handle: JobHandle) => Promise<void>;

/** Minimal surface the download orchestrator needs to enqueue work. */
export type DownloadsApi = Pick<DownloadsContextValue, 'enqueue'>;

type EnqueueOptions = { autoOpen?: boolean };

export type DownloadsContextValue = {
    jobs: DownloadJob[];
    activeJob: DownloadJob | null;
    queuedCount: number;
    activeCount: number; // active + queued (i.e. not yet finished)
    enqueue: (meta: DownloadMeta, runner: DownloadRunner, options?: EnqueueOptions) => string;
    cancelJob: (id: string) => void;
    retryJob: (id: string) => void;
    removeJob: (id: string) => void;
    clearFinished: () => void;
    /** Whether the user has the downloads/library window open (UI convenience). */
    windowOpen: boolean;
    setWindowOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

const DownloadsContext = createContext<DownloadsContextValue | undefined>(undefined);

const MAX_HISTORY = 100;
const isFinished = (s: DownloadStatus) => s === 'done' || s === 'error' || s === 'cancelled';

export const DownloadsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [jobs, setJobs] = useState<DownloadJob[]>([]);
    const [windowOpen, setWindowOpen] = useState(false);

    // Non-reactive bookkeeping for the serial runner.
    const runnersRef = useRef<Map<string, { meta: DownloadMeta; runner: DownloadRunner }>>(new Map());
    const controllersRef = useRef<Map<string, AbortController>>(new Map());
    const cancelledRef = useRef<Set<string>>(new Set());
    const runningRef = useRef(false);

    const patchJob = useCallback((id: string, partial: Partial<DownloadJob>) => {
        setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...partial } : j)));
    }, []);

    // Serial scheduler: run queued jobs one at a time, in FIFO order.
    const pump = useCallback(async () => {
        if (runningRef.current) return;
        runningRef.current = true;
        try {
            // Loop while there is a queued job.
            // We read the latest queue via a state snapshot each iteration.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const next = await new Promise<DownloadJob | undefined>((resolve) => {
                    setJobs((prev) => {
                        resolve(prev.find((j) => j.status === 'queued'));
                        return prev;
                    });
                });
                if (!next) break;

                const entry = runnersRef.current.get(next.id);
                if (!entry) {
                    // The job was removed (or its runner trimmed) between the queue
                    // snapshot and now — drop it silently rather than surfacing a
                    // misleading "Runner missing" error.
                    setJobs((prev) => prev.filter((j) => j.id !== next.id));
                    continue;
                }

                const controller = new AbortController();
                controllersRef.current.set(next.id, controller);
                cancelledRef.current.delete(next.id);
                patchJob(next.id, { status: 'active', startedAt: Date.now(), progress: 0, error: undefined });

                const handle: JobHandle = {
                    id: next.id,
                    signal: controller.signal,
                    update: (partial) => patchJob(next.id, partial),
                    isCancelled: () => cancelledRef.current.has(next.id)
                };

                try {
                    await entry.runner(handle);
                    if (cancelledRef.current.has(next.id)) {
                        patchJob(next.id, { status: 'cancelled', finishedAt: Date.now() });
                    } else {
                        patchJob(next.id, { status: 'done', progress: 100, stage: undefined, finishedAt: Date.now() });
                    }
                } catch (e) {
                    if (cancelledRef.current.has(next.id) || controller.signal.aborted) {
                        patchJob(next.id, { status: 'cancelled', finishedAt: Date.now() });
                    } else {
                        patchJob(next.id, { status: 'error', error: e instanceof Error ? e.message : 'Download failed', finishedAt: Date.now() });
                    }
                } finally {
                    controllersRef.current.delete(next.id);
                }
            }
        } finally {
            runningRef.current = false;
            // Trim history so completed jobs don't grow without bound.
            setJobs((prev) => {
                const finished = prev.filter((j) => isFinished(j.status));
                if (finished.length <= MAX_HISTORY) return prev;
                const overflow = new Set(finished.slice(0, finished.length - MAX_HISTORY).map((j) => j.id));
                overflow.forEach((id) => runnersRef.current.delete(id));
                return prev.filter((j) => !overflow.has(j.id));
            });
        }
    }, [patchJob]);

    const enqueue = useCallback(
        (meta: DownloadMeta, runner: DownloadRunner, options?: EnqueueOptions) => {
            const id = uuidv4();
            const job: DownloadJob = {
                id,
                kind: meta.kind,
                title: meta.title,
                subtitle: meta.subtitle,
                artworkUrl: meta.artworkUrl,
                status: 'queued',
                progress: 0,
                bytesDone: 0,
                bytesTotal: 0,
                createdAt: Date.now()
            };
            runnersRef.current.set(id, { meta, runner });
            setJobs((prev) => [...prev, job]);
            if (options?.autoOpen) setWindowOpen(true);
            // Kick the scheduler (no-op if already running).
            void pump();
            return id;
        },
        [pump]
    );

    const cancelJob = useCallback(
        (id: string) => {
            cancelledRef.current.add(id);
            const controller = controllersRef.current.get(id);
            if (controller) {
                controller.abort();
            } else {
                // Not yet started → drop from the queue immediately.
                setJobs((prev) => prev.map((j) => (j.id === id && j.status === 'queued' ? { ...j, status: 'cancelled', finishedAt: Date.now() } : j)));
            }
        },
        []
    );

    const retryJob = useCallback(
        (id: string) => {
            if (!runnersRef.current.has(id)) return;
            cancelledRef.current.delete(id);
            // Re-check the runner still exists right before requeuing, in case a
            // concurrent removeJob() deleted it after the guard above.
            setJobs((prev) => (runnersRef.current.has(id) ? prev.map((j) => (j.id === id ? { ...j, status: 'queued', progress: 0, bytesDone: 0, error: undefined, stage: undefined, startedAt: undefined, finishedAt: undefined } : j)) : prev));
            void pump();
        },
        [pump]
    );

    const removeJob = useCallback((id: string) => {
        cancelledRef.current.add(id);
        controllersRef.current.get(id)?.abort();
        controllersRef.current.delete(id);
        runnersRef.current.delete(id);
        setJobs((prev) => prev.filter((j) => j.id !== id));
    }, []);

    const clearFinished = useCallback(() => {
        setJobs((prev) => {
            prev.filter((j) => isFinished(j.status)).forEach((j) => runnersRef.current.delete(j.id));
            return prev.filter((j) => !isFinished(j.status));
        });
    }, []);

    const value = useMemo<DownloadsContextValue>(() => {
        const activeJob = jobs.find((j) => j.status === 'active' || j.status === 'processing') ?? null;
        const queuedCount = jobs.filter((j) => j.status === 'queued').length;
        const activeCount = jobs.filter((j) => !isFinished(j.status)).length;
        return { jobs, activeJob, queuedCount, activeCount, enqueue, cancelJob, retryJob, removeJob, clearFinished, windowOpen, setWindowOpen };
    }, [jobs, enqueue, cancelJob, retryJob, removeJob, clearFinished, windowOpen]);

    return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
};

export const useDownloads = () => {
    const ctx = useContext(DownloadsContext);
    if (!ctx) throw new Error('useDownloads must be used within a DownloadsProvider');
    return ctx;
};
