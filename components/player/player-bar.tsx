'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2Icon, ListMusicIcon, Music2Icon, PauseIcon, PlayIcon, Repeat1Icon, RepeatIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, Volume1Icon, Volume2Icon, VolumeXIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { usePlayer } from '@/lib/player/player-provider';
import { cn } from '@/lib/utils';

function fmt(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Icon button that always carries an accessible label + tooltip. */
const IconAction = ({ label, onClick, children, active, disabled, className }: { label: string; onClick?: () => void; children: React.ReactNode; active?: boolean; disabled?: boolean; className?: string }) => (
    <Tooltip>
        <TooltipTrigger asChild>
            <Button
                type='button'
                variant='ghost'
                size='icon'
                aria-label={label}
                aria-pressed={active}
                disabled={disabled}
                onClick={onClick}
                className={cn('size-9 rounded-full', active && 'text-primary', className)}
            >
                {children}
            </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
    </Tooltip>
);

const PlayerBar = ({ onOpenLibrary }: { onOpenLibrary: () => void }) => {
    const { current, isPlaying, loading, position, duration, volume, muted, shuffle, repeat, error, togglePlay, next, previous, seek, setVolume, toggleMute, toggleShuffle, cycleRepeat } = usePlayer();
    const [scrub, setScrub] = useState<number | null>(null);

    if (!current) return null;

    const displayPos = scrub ?? position;
    const total = duration || current.duration || 0;
    const VolumeIcon = muted || volume === 0 ? VolumeXIcon : volume < 0.5 ? Volume1Icon : Volume2Icon;

    return (
        <TooltipProvider delayDuration={300}>
            <AnimatePresence>
                <motion.div
                    key='player-bar'
                    role='region'
                    aria-label='Now playing'
                    initial={{ y: 120, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 120, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 28 }}
                    className='fixed bottom-0 left-0 z-30 w-full border-t border-border bg-card/85 backdrop-blur-xl'
                >
                    <div className='mx-auto flex w-full max-w-screen-2xl flex-col gap-1 px-3 py-2 sm:px-4'>
                        <div className='flex items-center gap-3'>
                            {/* Track identity */}
                            <div className='flex min-w-0 flex-1 items-center gap-3'>
                                <div className='relative size-11 shrink-0 overflow-hidden rounded-md bg-muted shadow'>
                                    {current.artworkUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={current.artworkUrl} alt='' className='size-full object-cover' />
                                    ) : (
                                        <div className='flex size-full items-center justify-center text-muted-foreground'>
                                            <Music2Icon className='size-5' />
                                        </div>
                                    )}
                                </div>
                                <div className='min-w-0'>
                                    <p className='truncate text-sm font-semibold leading-tight'>{current.title}</p>
                                    <p className='truncate text-xs text-muted-foreground'>{current.artist}</p>
                                </div>
                                {current.hires && (
                                    <Badge variant='secondary' className='hidden shrink-0 sm:inline-flex'>
                                        {current.bitDepth}/{Math.round(current.sampleRate)}
                                    </Badge>
                                )}
                            </div>

                            {/* Transport */}
                            <div className='flex items-center gap-0.5 sm:gap-1'>
                                <IconAction label={shuffle ? 'Shuffle on' : 'Shuffle off'} active={shuffle} onClick={toggleShuffle} className='hidden sm:inline-flex'>
                                    <ShuffleIcon className='size-4' />
                                </IconAction>
                                <IconAction label='Previous track' onClick={previous}>
                                    <SkipBackIcon className='size-5' />
                                </IconAction>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            type='button'
                                            size='icon'
                                            aria-label={isPlaying ? 'Pause' : 'Play'}
                                            onClick={togglePlay}
                                            className='size-10 rounded-full'
                                        >
                                            {loading ? <Loader2Icon className='size-5 animate-spin' /> : isPlaying ? <PauseIcon className='size-5' /> : <PlayIcon className='size-5' />}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>{isPlaying ? 'Pause' : 'Play'}</TooltipContent>
                                </Tooltip>
                                <IconAction label='Next track' onClick={next}>
                                    <SkipForwardIcon className='size-5' />
                                </IconAction>
                                <IconAction
                                    label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat off'}
                                    active={repeat !== 'off'}
                                    onClick={cycleRepeat}
                                    className='hidden sm:inline-flex'
                                >
                                    {repeat === 'one' ? <Repeat1Icon className='size-4' /> : <RepeatIcon className='size-4' />}
                                </IconAction>
                            </div>

                            {/* Right cluster */}
                            <div className='flex flex-1 items-center justify-end gap-1'>
                                <div className='hidden items-center gap-1 md:flex'>
                                    <IconAction label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
                                        <VolumeIcon className='size-4' />
                                    </IconAction>
                                    <Slider
                                        aria-label='Volume'
                                        value={[muted ? 0 : volume * 100]}
                                        max={100}
                                        step={1}
                                        onValueChange={(v) => setVolume(v[0] / 100)}
                                        className='w-24'
                                    />
                                </div>
                                <IconAction label='Open library & queue' onClick={onOpenLibrary}>
                                    <ListMusicIcon className='size-5' />
                                </IconAction>
                            </div>
                        </div>

                        {/* Seek bar */}
                        <div className='flex items-center gap-2'>
                            <span className='w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground'>{fmt(displayPos)}</span>
                            <Slider
                                aria-label='Seek'
                                value={[Math.min(displayPos, total)]}
                                max={total || 1}
                                step={1}
                                onValueChange={(v) => setScrub(v[0])}
                                onValueCommit={(v) => {
                                    seek(v[0]);
                                    setScrub(null);
                                }}
                                className='flex-1'
                            />
                            <span className='w-10 shrink-0 text-[11px] tabular-nums text-muted-foreground'>{fmt(total)}</span>
                        </div>

                        {error && <p className='px-1 text-[11px] text-destructive'>{error}</p>}
                    </div>
                </motion.div>
            </AnimatePresence>
        </TooltipProvider>
    );
};

export default PlayerBar;
