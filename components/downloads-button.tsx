'use client';

import React from 'react';
import { Loader2Icon, ListMusicIcon } from 'lucide-react';
import { Button } from './ui/button';
import { useDownloads } from '@/lib/downloads/downloads-provider';

/** Header launcher for the Library/Downloads window, with a live activity badge. */
const DownloadsButton = () => {
    const { activeCount, activeJob, setWindowOpen } = useDownloads();
    return (
        <Button
            variant='outline'
            size='icon'
            className='relative'
            aria-label={activeCount > 0 ? `Library — ${activeCount} download${activeCount === 1 ? '' : 's'} in progress` : 'Open library and downloads'}
            onClick={() => setWindowOpen(true)}
        >
            {activeJob ? <Loader2Icon className='animate-spin' /> : <ListMusicIcon />}
            {activeCount > 0 && (
                <span
                    aria-hidden
                    className='absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground'
                >
                    {activeCount > 9 ? '9+' : activeCount}
                </span>
            )}
        </Button>
    );
};

export default DownloadsButton;
