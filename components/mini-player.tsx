'use client';
import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2Icon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, Volume2Icon, VolumeXIcon, XIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Slider } from './ui/slider';
import { formatArtists, formatTitle, getAlbum } from '@/lib/qobuz-dl';
import { usePlayer } from '@/lib/player-provider';

// Height of the bar, shared with the status bar and page padding so nothing hides behind it.
export const MINI_PLAYER_HEIGHT = 80;

function formatClock(seconds: number) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

const MiniPlayer = () => {
    const { current, queue, index, playing, loading, currentTime, duration, volume, togglePlay, next, previous, seek, setVolume, stop } = usePlayer();

    // While the seek thumb is being dragged, show its position without actually seeking until release.
    const [dragTime, setDragTime] = useState<number | null>(null);
    const shownTime = dragTime ?? currentTime;

    const album = current ? getAlbum(current) : null;

    return (
        <AnimatePresence>
            {current && (
                <motion.div
                    key='mini-player'
                    className='fixed bottom-0 left-0 w-full z-[30] border-t bg-background/90 backdrop-blur-md'
                    style={{ height: MINI_PLAYER_HEIGHT }}
                    initial={{ y: MINI_PLAYER_HEIGHT, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: MINI_PLAYER_HEIGHT, opacity: 0 }}
                    transition={{ type: 'spring', bounce: 0.15 }}
                >
                    {/* Thin progress line for small screens, where the full seek bar is hidden. */}
                    <div className='absolute top-0 left-0 h-0.5 bg-primary md:hidden' style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
                    <div className='mx-auto max-w-[1600px] h-full px-4 flex items-center gap-4'>
                        <div className='flex items-center gap-3 min-w-0 flex-1 md:flex-none md:w-[30%]'>
                            <div className='relative shrink-0 size-12 rounded-sm overflow-hidden bg-secondary'>
                                {album?.image?.small && (
                                    <img src={album.image.small} alt={album.title} crossOrigin='anonymous' className='w-full h-full object-cover' />
                                )}
                            </div>
                            <div className='min-w-0'>
                                <p className='text-sm font-bold truncate' title={formatTitle(current)}>
                                    {formatTitle(current)}
                                </p>
                                <p className='text-xs text-muted-foreground truncate' title={formatArtists(current)}>
                                    {formatArtists(current)}
                                </p>
                            </div>
                        </div>

                        <div className='flex flex-col items-center justify-center gap-1 md:flex-1'>
                            <div className='flex items-center gap-1'>
                                <Button variant='ghost' size='icon' onClick={previous} title='Previous' className='hidden sm:inline-flex'>
                                    <SkipBackIcon />
                                </Button>
                                <Button variant='default' size='icon' onClick={togglePlay} title={playing ? 'Pause' : 'Play'} className='rounded-full'>
                                    {loading ? <Loader2Icon className='animate-spin' /> : playing ? <PauseIcon /> : <PlayIcon />}
                                </Button>
                                <Button variant='ghost' size='icon' onClick={next} title='Next' disabled={index + 1 >= queue.length}>
                                    <SkipForwardIcon />
                                </Button>
                            </div>
                            <div className='hidden md:flex items-center gap-2 w-full max-w-[600px] text-[10px] text-muted-foreground tabular-nums'>
                                <span className='w-8 text-right'>{formatClock(shownTime)}</span>
                                <Slider
                                    value={[Math.min(shownTime, duration || 0)]}
                                    max={duration || 1}
                                    step={1}
                                    onValueChange={([value]) => setDragTime(value)}
                                    onValueCommit={([value]) => {
                                        seek(value);
                                        setDragTime(null);
                                    }}
                                    aria-label='Seek'
                                />
                                <span className='w-8'>{formatClock(duration)}</span>
                            </div>
                        </div>

                        <div className='flex items-center justify-end gap-2 md:w-[30%]'>
                            <div className='hidden lg:flex items-center gap-2 w-32'>
                                <Button variant='ghost' size='icon' onClick={() => setVolume(volume > 0 ? 0 : 1)} title={volume > 0 ? 'Mute' : 'Unmute'}>
                                    {volume > 0 ? <Volume2Icon /> : <VolumeXIcon />}
                                </Button>
                                <Slider value={[volume]} max={1} step={0.01} onValueChange={([value]) => setVolume(value)} aria-label='Volume' />
                            </div>
                            <Button variant='ghost' size='icon' onClick={stop} title='Close player'>
                                <XIcon />
                            </Button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default MiniPlayer;
