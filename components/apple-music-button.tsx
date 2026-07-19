'use client';

import { Button } from '@/components/ui/button';
import { FaApple } from '@react-icons/all-files/fa/FaApple';
import { useEffect, useState } from 'react';

/**
 * Resolves the URL of the companion Apple Music (ALACarte) service that runs
 * alongside Tryptify in the same docker-compose stack.
 *
 * Precedence:
 *  1. NEXT_PUBLIC_APPLE_MUSIC_URL   - a full, ready-made URL (e.g. behind a
 *     reverse proxy at https://music.example.com). Used verbatim.
 *  2. Same host as Tryptify, on the Apple Music port. The port defaults to
 *     7373 and can be overridden with NEXT_PUBLIC_APPLE_MUSIC_PORT.
 *
 * Because the two apps are served from the same host but different ports, the
 * host portion is resolved client-side from window.location so the link works
 * whether the stack is reached via localhost, a LAN IP, or a hostname.
 */
const useAppleMusicUrl = (): string | null => {
    const [url, setUrl] = useState<string | null>(null);

    useEffect(() => {
        const explicit = process.env.NEXT_PUBLIC_APPLE_MUSIC_URL;
        if (explicit) {
            setUrl(explicit);
            return;
        }

        if (typeof window === 'undefined') return;

        const port = process.env.NEXT_PUBLIC_APPLE_MUSIC_PORT || '7373';
        setUrl(`${window.location.protocol}//${window.location.hostname}:${port}`);
    }, []);

    return url;
};

export default function AppleMusicButton() {
    const url = useAppleMusicUrl();

    if (!url) return null;

    return (
        <a href={url} target='_blank' rel='noopener noreferrer' title='Open the Apple Music downloader'>
            <Button variant='outline' className='flex gap-2 items-center'>
                <FaApple />
                <span className='hidden sm:inline'>Apple Music</span>
            </Button>
        </a>
    );
}
