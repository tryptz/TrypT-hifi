'use client';

import React, { useEffect, useState } from 'react';
import { HardDriveIcon, Loader2Icon, Music2Icon, PauseIcon, PlayIcon, Trash2Icon } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { usePlayer } from '@/lib/player/player-provider';
import { clearLibrary, getStorageEstimate, LibraryTrackMeta } from '@/lib/library-store';
import { formatBytes } from '@/lib/utils';
import { cn } from '@/lib/utils';

function fmt(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

const TrackRow = ({ track, index }: { track: LibraryTrackMeta; index: number }) => {
    const { library, playList, isCurrent, isPlaying, togglePlay, removeFromLibrary } = usePlayer();
    const active = isCurrent(track.id);

    return (
        <li
            className={cn(
                'group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent',
                active && 'bg-accent'
            )}
        >
            <button
                type='button'
                aria-label={active && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                onClick={() => (active ? togglePlay() : playList(library, index))}
                className='relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
                {track.artworkUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={track.artworkUrl} alt='' className='size-full object-cover' />
                ) : (
                    <Music2Icon className='size-5' />
                )}
                <span className={cn('absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100', active && 'opacity-100')}>
                    {active && isPlaying ? <PauseIcon className='size-5' /> : <PlayIcon className='size-5' />}
                </span>
            </button>

            <div className='min-w-0 flex-1'>
                <p className={cn('truncate text-sm font-medium', active && 'text-primary')}>{track.title}</p>
                <p className='truncate text-xs text-muted-foreground'>
                    {track.artist}
                    {track.album ? ` · ${track.album}` : ''}
                </p>
            </div>

            {track.hires && (
                <Badge variant='secondary' className='hidden shrink-0 md:inline-flex'>
                    {track.bitDepth}/{Math.round(track.sampleRate)}
                </Badge>
            )}
            <span className='hidden w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline'>{fmt(track.duration)}</span>

            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        className='size-8 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                        aria-label={`Remove ${track.title} from library`}
                        onClick={() => void removeFromLibrary(track.id)}
                    >
                        <Trash2Icon className='size-4' />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Remove from library</TooltipContent>
            </Tooltip>
        </li>
    );
};

const SavedTab = () => {
    const { library, libraryLoading, playList, refreshLibrary } = usePlayer();
    const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);

    const totalSize = library.reduce((sum, t) => sum + (t.size || 0), 0);

    useEffect(() => {
        void getStorageEstimate().then(setEstimate);
    }, [library.length]);

    const handleClear = async () => {
        await clearLibrary();
        await refreshLibrary();
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('trypt:library-changed'));
    };

    if (libraryLoading) {
        return (
            <div className='flex h-64 items-center justify-center text-muted-foreground'>
                <Loader2Icon className='size-5 animate-spin' />
            </div>
        );
    }

    if (library.length === 0) {
        return (
            <div className='flex h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground'>
                <Music2Icon className='size-8 opacity-60' />
                <p className='text-sm font-medium'>Your library is empty</p>
                <p className='max-w-xs text-xs'>
                    Turn on <span className='font-medium text-foreground'>Save to library</span> in Settings, then download a track or album to play it here.
                </p>
            </div>
        );
    }

    return (
        <div className='flex flex-col gap-3'>
            <div className='flex items-center justify-between gap-2'>
                <Button type='button' size='sm' onClick={() => playList(library, 0)} className='gap-2'>
                    <PlayIcon className='size-4' />
                    Play all
                </Button>
                <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                    <HardDriveIcon className='size-3.5' />
                    <span>
                        {library.length} {library.length === 1 ? 'track' : 'tracks'} · {formatBytes(totalSize)}
                        {estimate && estimate.quota > 0 ? ` of ${formatBytes(estimate.quota)}` : ''}
                    </span>
                    <Button type='button' variant='ghost' size='sm' className='h-7 gap-1.5 px-2 text-destructive hover:text-destructive' onClick={() => void handleClear()}>
                        <Trash2Icon className='size-3.5' />
                        Clear
                    </Button>
                </div>
            </div>
            <ScrollArea className='h-[min(60vh,28rem)] pr-3'>
                <ul className='flex flex-col gap-0.5'>
                    {library.map((track, index) => (
                        <TrackRow key={track.id} track={track} index={index} />
                    ))}
                </ul>
            </ScrollArea>
        </div>
    );
};

export default SavedTab;
