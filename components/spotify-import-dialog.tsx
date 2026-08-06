'use client';

import axios from 'axios';
import Image from 'next/image';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { ArrowLeftIcon, CheckIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, Loader2Icon, LogOutIcon, SearchXIcon } from 'lucide-react';
import { FaSpotify } from '@react-icons/all-files/fa/FaSpotify';
import { cn } from '@/lib/utils';
import { createDownloadJob } from '@/lib/download-job';
import { formatArtists, formatTitle, QobuzTrack } from '@/lib/qobuz-dl';
import {
    formatSpotifyArtists,
    LIKED_SONGS_ID,
    matchConfidenceLabels,
    parseSpotifyPlaylistId,
    SpotifyMatch,
    SpotifyPlaylist,
    SpotifyPlaylistSummary,
    SpotifyTrack,
    SpotifyUser
} from '@/lib/spotify';
import SpotifyPlaylistLibrary from './spotify-playlist-library';
import { useCountry } from '@/lib/country-provider';
import { useFFmpeg } from '@/lib/ffmpeg-provider';
import { useSettings } from '@/lib/settings-provider';
import { useStatusBar } from '@/lib/status-bar/context';
import { useToast } from '@/hooks/use-toast';

// How many tracks are resolved against Qobuz at once. Kept low so a long
// playlist doesn't hammer the Qobuz API (each track is at least one search).
const MATCH_CONCURRENCY = 4;

type ImportStage = 'idle' | 'loading' | 'matching' | 'done';

// `failed` separates "Qobuz has nothing like this" from "the lookup itself broke".
type TrackMatch = SpotifyMatch & { failed?: boolean };

type SpotifySessionInfo = { configured: boolean; authenticated: boolean; user: SpotifyUser | null };

const SpotifyImportDialog = ({
    open,
    setOpen,
    initialUrl = '',
    authNotice = ''
}: {
    open: boolean;
    setOpen: (open: boolean) => void;
    initialUrl?: string;
    authNotice?: string;
}) => {
    const [url, setUrl] = useState(initialUrl);
    const [session, setSession] = useState<SpotifySessionInfo | null>(null);
    const [library, setLibrary] = useState<{ items: SpotifyPlaylistSummary[]; hasMore: boolean } | null>(null);
    const [libraryLoading, setLibraryLoading] = useState(false);
    const [libraryError, setLibraryError] = useState('');
    const [stage, setStage] = useState<ImportStage>('idle');
    const [error, setError] = useState<string>('');
    const [playlist, setPlaylist] = useState<SpotifyPlaylist | null>(null);
    // Keyed by index rather than track id — playlists can list the same track twice.
    const [matches, setMatches] = useState<Record<number, TrackMatch>>({});
    const [copied, setCopied] = useState(false);

    const controllerRef = useRef<AbortController | null>(null);

    const { country } = useCountry();
    const { ffmpegState } = useFFmpeg();
    const { settings } = useSettings();
    const { setStatusBar } = useStatusBar();
    const { toast } = useToast();

    const matchAll = async (loaded: SpotifyPlaylist, controller: AbortController) => {
        let cursor = 0;
        const worker = async () => {
            while (cursor < loaded.tracks.length) {
                const index = cursor++;
                const track = loaded.tracks[index];
                let match: TrackMatch = { matched: false, confidence: null, score: 0, url: null, track: null };
                try {
                    const response = await axios.get('/api/spotify/match', {
                        params: {
                            title: track.title,
                            artists: track.artists.join('|'),
                            album: track.album,
                            isrc: track.isrc ?? '',
                            explicit: String(track.explicit),
                            duration: track.duration
                        },
                        headers: { 'Token-Country': country },
                        signal: controller.signal
                    });
                    match = response.data.data;
                } catch (requestError: any) {
                    if (axios.isCancel(requestError)) return;
                    match.failed = true;
                    // Surface the first real failure — a broken Qobuz token would
                    // otherwise look like a playlist full of unavailable tracks.
                    const message = requestError?.response?.data?.error;
                    setError((previous) => previous || (typeof message === 'string' ? message : requestError.message || 'Some tracks could not be matched.'));
                }
                if (controller.signal.aborted) return;
                setMatches((previous) => ({ ...previous, [index]: match }));
            }
        };
        await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, loaded.tracks.length) }, worker));
    };

    // Either a pasted link or a playlist picked from the signed-in user's library.
    const importPlaylist = async (target: { url?: string; id?: string }) => {
        if (target.url && !parseSpotifyPlaylistId(target.url)) {
            setError('That does not look like a Spotify playlist link.');
            return;
        }
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;

        setError('');
        setPlaylist(null);
        setMatches({});
        setCopied(false);
        setStage('loading');
        try {
            const response = await axios.get('/api/spotify/playlist', {
                params: target.id ? { id: target.id } : { url: target.url },
                signal: controller.signal
            });
            const loaded: SpotifyPlaylist = response.data.data;
            if (controller.signal.aborted) return;
            setPlaylist(loaded);
            setStage('matching');
            await matchAll(loaded, controller);
            if (controller.signal.aborted) return;
            setStage('done');
        } catch (error: any) {
            if (axios.isCancel(error)) return;
            const message = error?.response?.data?.error;
            setError(typeof message === 'string' ? message : message ? JSON.stringify(message) : error.message || 'An error occurred.');
            setStage('idle');
        }
    };

    // Drops the current results and returns to the playlist window, stopping any
    // matching still in flight.
    const backToLibrary = () => {
        controllerRef.current?.abort();
        autoImportedRef.current = '';
        setPlaylist(null);
        setMatches({});
        setError('');
        setStage('idle');
        if (!library) loadLibrary(0);
    };

    const loadLibrary = async (offset: number) => {
        setLibraryLoading(true);
        setLibraryError('');
        try {
            const response = await axios.get('/api/spotify/me/playlists', { params: { offset } });
            const page = response.data.data;
            setLibrary((previous) =>
                offset === 0 || !previous ? { items: page.items, hasMore: page.hasMore } : { items: [...previous.items, ...page.items], hasMore: page.hasMore }
            );
        } catch (libraryFetchError: any) {
            const message = libraryFetchError?.response?.data?.error;
            setLibraryError(typeof message === 'string' ? message : libraryFetchError.message || 'Could not load your playlists.');
        }
        setLibraryLoading(false);
    };

    const loadSession = async () => {
        try {
            const response = await axios.get('/api/spotify/auth/session');
            const info: SpotifySessionInfo = response.data.data;
            setSession(info);
            if (info.authenticated && !library) loadLibrary(0);
        } catch {
            setSession({ configured: true, authenticated: false, user: null });
        }
    };

    const logout = async () => {
        await axios.post('/api/spotify/auth/session').catch(() => {});
        setSession({ configured: true, authenticated: false, user: null });
        setLibrary(null);
    };

    // The dialog is mounted for the whole session, so the login state is
    // (re)checked each time it is opened — including after the OAuth redirect.
    useEffect(() => {
        if (open) loadSession();
    }, [open]);

    useEffect(() => {
        if (authNotice) setError(authNotice);
    }, [authNotice]);

    // A link pasted into the search bar arrives as `initialUrl` and imports itself
    // once; reopening the dialog afterwards keeps the results it already has.
    const autoImportedRef = useRef<string>('');
    useEffect(() => {
        if (!initialUrl) return;
        setUrl(initialUrl);
        if (open && autoImportedRef.current !== initialUrl) {
            autoImportedRef.current = initialUrl;
            importPlaylist({ url: initialUrl });
        }
    }, [initialUrl, open]);

    useEffect(() => {
        // Stop matching when the dialog is dismissed mid-import.
        if (!open) controllerRef.current?.abort();
    }, [open]);

    const matchedEntries = playlist
        ? playlist.tracks.map((track, index) => ({ track, index, match: matches[index] })).filter((entry) => entry.match?.matched && entry.match.track)
        : [];
    const resolvedCount = Object.keys(matches).length;
    const failedCount = Object.values(matches).filter((match) => match.failed).length;
    const progress = playlist && playlist.tracks.length > 0 ? (resolvedCount / playlist.tracks.length) * 100 : 0;

    const copyLinks = async () => {
        const links = matchedEntries.map((entry) => entry.match!.url).join('\n');
        try {
            await navigator.clipboard.writeText(links);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast({ title: 'Could not copy', description: 'Clipboard access was denied by the browser.' });
        }
    };

    const downloadTrack = async (track: QobuzTrack) => {
        await createDownloadJob(track, setStatusBar, ffmpegState!, settings, toast as any, undefined, undefined, country);
    };

    const downloadAll = async () => {
        toast({ title: `Adding ${matchedEntries.length} tracks`, description: 'Matched tracks are being added to the queue' });
        for (const entry of matchedEntries) {
            await downloadTrack(entry.match!.track!);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className='w-[760px] max-w-[95%] md:max-w-[85%] overflow-hidden'>
                <div className='space-y-1.5'>
                    <DialogTitle className='flex items-center gap-2'>
                        <FaSpotify className='size-5 shrink-0' />
                        Import a Spotify playlist
                    </DialogTitle>
                    <DialogDescription>Paste a public Spotify playlist link and every track will be translated to its Qobuz equivalent.</DialogDescription>
                </div>

                <div className='flex items-center gap-2'>
                    <Input
                        placeholder='https://open.spotify.com/playlist/...'
                        value={url}
                        autoComplete='off'
                        spellCheck={false}
                        onChange={(event) => setUrl(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && url.trim().length > 0 && stage !== 'loading' && stage !== 'matching')
                                importPlaylist({ url: url.trim() });
                        }}
                    />
                    <Button
                        className='shrink-0'
                        disabled={url.trim().length === 0 || stage === 'loading' || stage === 'matching'}
                        onClick={() => importPlaylist({ url: url.trim() })}
                    >
                        {stage === 'loading' || stage === 'matching' ? <Loader2Icon className='animate-spin' /> : 'Import'}
                    </Button>
                </div>

                {error && <p className='text-destructive text-sm font-semibold'>{error}</p>}

                {/* Signed out: offer the login that unlocks private playlists and Liked Songs. */}
                {session?.configured && !session.authenticated && (
                    <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border p-3'>
                        <p className='text-sm text-muted-foreground max-w-[60%]'>
                            Log in with Spotify to browse your own playlists, including private ones and Liked Songs.
                        </p>
                        {/* A full navigation, not client-side routing: the OAuth
                            handshake leaves the app and comes back via redirect. */}
                        <Button className='flex gap-2 shrink-0' onClick={() => (window.location.href = '/api/spotify/auth/login')}>
                            <FaSpotify />
                            <span>Log in with Spotify</span>
                        </Button>
                    </div>
                )}

                {session && !session.configured && (
                    <p className='text-sm text-muted-foreground'>
                        Spotify login is not configured on this deployment. Public playlist links still work once SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
                        are set.
                    </p>
                )}

                {/* Signed in, nothing picked yet: the playlist window. */}
                {session?.authenticated && !playlist && (
                    <>
                        <div className='flex items-center justify-between gap-2'>
                            <div className='flex items-center gap-2 overflow-hidden'>
                                {session.user?.image && (
                                    <div className='relative shrink-0 aspect-square w-7 h-7 rounded-full overflow-hidden'>
                                        <Image fill src={session.user.image} alt={session.user.name} sizes='28px' className='object-cover' />
                                    </div>
                                )}
                                <p className='text-sm font-semibold truncate'>{session.user?.name}</p>
                            </div>
                            <Button variant='ghost' size='sm' className='flex gap-2 shrink-0' onClick={logout}>
                                <LogOutIcon className='!size-4' />
                                <span>Log out</span>
                            </Button>
                        </div>
                        <Separator />
                        <SpotifyPlaylistLibrary
                            items={library?.items ?? []}
                            hasMore={!!library?.hasMore}
                            loading={libraryLoading}
                            error={libraryError}
                            onSelect={(selected) => importPlaylist({ id: selected.id })}
                            // Liked Songs is a local addition, so it must not count towards Spotify's paging offset.
                            onLoadMore={() => loadLibrary((library?.items ?? []).filter((item) => item.id !== LIKED_SONGS_ID).length)}
                        />
                    </>
                )}

                {playlist && (
                    <>
                        {session?.authenticated && (
                            <Button variant='ghost' size='sm' className='flex gap-2 self-start' onClick={backToLibrary}>
                                <ArrowLeftIcon className='!size-4' />
                                <span>Your playlists</span>
                            </Button>
                        )}
                        <div className='flex gap-3 overflow-hidden'>
                            {playlist.image && (
                                <div className='relative shrink-0 aspect-square w-[72px] h-[72px] rounded-sm overflow-hidden'>
                                    {/* Served through next/image so the cover stays same-origin under COEP. */}
                                    <Image fill src={playlist.image} alt={playlist.name} sizes='72px' className='object-cover' />
                                </div>
                            )}
                            <div className='flex flex-col justify-center overflow-hidden gap-0.5'>
                                <a
                                    href={playlist.url}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                    className='font-bold truncate hover:underline'
                                    title={playlist.name}
                                >
                                    {playlist.name}
                                </a>
                                <p className='text-sm text-muted-foreground truncate'>
                                    {playlist.owner && `${playlist.owner} · `}
                                    {playlist.tracks.length} {playlist.tracks.length === 1 ? 'track' : 'tracks'}
                                    {playlist.truncated && ` of ${playlist.total}`}
                                </p>
                                <p className='text-sm text-muted-foreground truncate'>
                                    {stage === 'matching'
                                        ? `Matching on Qobuz… ${resolvedCount}/${playlist.tracks.length}`
                                        : `${matchedEntries.length} matched · ${resolvedCount - matchedEntries.length - failedCount} not found` +
                                          (failedCount > 0 ? ` · ${failedCount} failed` : '')}
                                </p>
                            </div>
                        </div>

                        {stage === 'matching' && <Progress value={progress} className='h-2' />}

                        <Separator />

                        <ScrollArea className='max-h-[40vh]'>
                            <div className='flex flex-col overflow-hidden pr-3'>
                                {playlist.tracks.map((track: SpotifyTrack, index: number) => {
                                    const match = matches[index];
                                    return (
                                        <div key={`${track.id}-${index}`}>
                                            <div className='flex items-center justify-between gap-2 overflow-hidden hover:bg-primary/5 transition-all p-2 rounded group'>
                                                <div className='flex items-center gap-2 overflow-hidden'>
                                                    <span className='text-muted-foreground text-sm w-6 shrink-0 text-right'>{index + 1}</span>
                                                    <div className='overflow-hidden'>
                                                        <p className='truncate font-medium text-sm'>{track.title}</p>
                                                        <p className='truncate text-xs text-muted-foreground'>{formatSpotifyArtists(track)}</p>
                                                    </div>
                                                </div>
                                                <div className='flex items-center gap-2 shrink-0 max-w-[55%] overflow-hidden'>
                                                    {!match ? (
                                                        <Loader2Icon className='size-4 animate-spin text-muted-foreground' />
                                                    ) : match.matched && match.track ? (
                                                        <>
                                                            <div className='hidden sm:block overflow-hidden text-right'>
                                                                <p className='truncate text-sm' title={formatTitle(match.track)}>
                                                                    {formatTitle(match.track)}
                                                                </p>
                                                                <p className='truncate text-xs text-muted-foreground'>
                                                                    {formatArtists(match.track)} · {match.track.maximum_bit_depth}-bit /{' '}
                                                                    {match.track.maximum_sampling_rate} kHz
                                                                </p>
                                                            </div>
                                                            <p
                                                                className={cn(
                                                                    'text-[10px] px-1 py-0.5 rounded-[3px] shrink-0 font-semibold',
                                                                    match.confidence === 'isrc' || match.confidence === 'high'
                                                                        ? 'bg-primary text-primary-foreground'
                                                                        : 'bg-secondary text-secondary-foreground'
                                                                )}
                                                                title={`Match confidence: ${match.score}`}
                                                            >
                                                                {matchConfidenceLabels[match.confidence!]}
                                                            </p>
                                                            <a href={match.url!} target='_blank' rel='noopener noreferrer' title='Open on Qobuz'>
                                                                <Button size='icon' variant='ghost' className='h-7 w-7'>
                                                                    <ExternalLinkIcon className='!size-4' />
                                                                </Button>
                                                            </a>
                                                            <Button
                                                                size='icon'
                                                                variant='ghost'
                                                                className='h-7 w-7'
                                                                title={`Download '${formatTitle(match.track)}'`}
                                                                onClick={async () => {
                                                                    await downloadTrack(match.track!);
                                                                    toast({
                                                                        title: `Added '${formatTitle(match.track!)}'`,
                                                                        description: 'The track has been added to the queue'
                                                                    });
                                                                }}
                                                            >
                                                                <DownloadIcon className='!size-4' />
                                                            </Button>
                                                        </>
                                                    ) : (
                                                        <div
                                                            className={cn(
                                                                'flex items-center gap-1.5',
                                                                match.failed ? 'text-destructive' : 'text-muted-foreground'
                                                            )}
                                                        >
                                                            <SearchXIcon className='size-4 shrink-0' />
                                                            <span className='text-xs'>{match.failed ? 'Lookup failed' : 'No Qobuz match'}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            {index < playlist.tracks.length - 1 && <Separator />}
                                        </div>
                                    );
                                })}
                            </div>
                        </ScrollArea>

                        <div className='flex flex-wrap items-center justify-between gap-2'>
                            <p className='text-xs text-muted-foreground'>
                                {playlist.truncated && `Only the first ${playlist.tracks.length} tracks were imported. `}
                                Links point at open.qobuz.com.
                            </p>
                            <div className='flex items-center gap-2'>
                                <Button variant='outline' disabled={matchedEntries.length === 0} onClick={copyLinks} className='flex gap-2'>
                                    {copied ? <CheckIcon className='!size-4' /> : <CopyIcon className='!size-4' />}
                                    <span>{copied ? 'Copied' : 'Copy links'}</span>
                                </Button>
                                <Button disabled={matchedEntries.length === 0} onClick={downloadAll} className='flex gap-2'>
                                    <DownloadIcon className='!size-4' />
                                    <span>Download {matchedEntries.length > 0 ? matchedEntries.length : ''} matched</span>
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default SpotifyImportDialog;
