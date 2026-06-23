'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { useDownloads } from '@/lib/downloads/downloads-provider';

// Player + library chrome is client-only (depends on Audio + IndexedDB), so load
// it lazily to keep it out of the server bundle.
const PlayerBar = dynamic(() => import('./player/player-bar'), { ssr: false });
const LibraryWindow = dynamic(() => import('./library/library-window'), { ssr: false });

const AppChrome = () => {
    const { windowOpen, setWindowOpen } = useDownloads();
    return (
        <>
            <PlayerBar onOpenLibrary={() => setWindowOpen(true)} />
            <LibraryWindow open={windowOpen} onOpenChange={setWindowOpen} />
        </>
    );
};

export default AppChrome;
