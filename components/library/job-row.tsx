'use client';

import React from 'react';
import { DiscAlbumIcon, Music2Icon, RotateCwIcon, XIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Progress } from '../ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { DownloadJob, useDownloads } from '@/lib/downloads/downloads-provider';
import { cn } from '@/lib/utils';

const statusLabel: Record<DownloadJob['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' }> = {
    queued: { label: 'Queued', variant: 'secondary' },
    active: { label: 'Downloading', variant: 'default' },
    processing: { label: 'Processing', variant: 'default' },
    done: { label: 'Done', variant: 'success' },
    error: { label: 'Error', variant: 'destructive' },
    cancelled: { label: 'Cancelled', variant: 'outline' }
};

const JobRow = ({ job }: { job: DownloadJob }) => {
    const { cancelJob, retryJob, removeJob } = useDownloads();
    const inFlight = job.status === 'queued' || job.status === 'active' || job.status === 'processing';
    const showProgress = job.status === 'active' || job.status === 'processing';
    const status = statusLabel[job.status];

    return (
        <li className='flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-2.5'>
            <div className='flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground'>
                {job.artworkUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={job.artworkUrl} alt='' className='size-full object-cover' />
                ) : job.kind === 'album' ? (
                    <DiscAlbumIcon className='size-5' />
                ) : (
                    <Music2Icon className='size-5' />
                )}
            </div>

            <div className='min-w-0 flex-1'>
                <div className='flex items-center gap-2'>
                    <p className='truncate text-sm font-medium'>{job.title}</p>
                    <Badge variant={status.variant} className='shrink-0'>
                        {status.label}
                    </Badge>
                </div>
                {job.subtitle && <p className='truncate text-xs text-muted-foreground'>{job.subtitle}</p>}
                {showProgress && (
                    <div className='mt-1.5 flex items-center gap-2'>
                        <Progress value={job.progress} className='h-1.5' />
                        <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>{Math.round(job.progress)}%</span>
                    </div>
                )}
                {(showProgress || job.status === 'error') && (
                    <p className={cn('mt-0.5 truncate text-[11px]', job.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{job.error ?? job.stage}</p>
                )}
            </div>

            <div className='flex shrink-0 items-center gap-1'>
                {!inFlight && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button type='button' variant='ghost' size='icon' className='size-8' aria-label={`Retry ${job.title}`} onClick={() => retryJob(job.id)}>
                                <RotateCwIcon className='size-4' />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Retry</TooltipContent>
                    </Tooltip>
                )}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type='button'
                            variant='ghost'
                            size='icon'
                            className='size-8'
                            aria-label={inFlight ? `Cancel ${job.title}` : `Remove ${job.title}`}
                            onClick={() => (inFlight ? cancelJob(job.id) : removeJob(job.id))}
                        >
                            <XIcon className='size-4' />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>{inFlight ? 'Cancel' : 'Remove'}</TooltipContent>
                </Tooltip>
            </div>
        </li>
    );
};

export default JobRow;
