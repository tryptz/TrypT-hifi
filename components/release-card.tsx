import ArtistDialog from './artist-dialog';
import SourceTag from './source-tag';
import DolbyAtmosBadge from './dolby-atmos-badge';
import DownloadAlbumButton from './download-album-button';
import Image from 'next/image';
import React, { useEffect, useState } from 'react';
import { AlignJustifyIcon, DotIcon, DownloadIcon, UsersIcon, DiscAlbumIcon, ExternalLinkIcon, Loader2Icon, PlayIcon } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import { createDownloadJob } from '@/lib/download-job';
import { createAppleDownloadJob } from '@/lib/apple-download-job';
import { getFullAppleAlbumInfo } from '@/lib/apple-music';
import { DeezerExtras, getFullDeezerAlbumInfo } from '@/lib/deezer';
import { getFullTidalAlbumInfo, isTidalAtmos } from '@/lib/tidal';
import { useSource } from '@/lib/source-provider';
import { useAppleHandoff } from '@/lib/apple-handoff-provider';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
    FetchedQobuzAlbum,
    formatArtists,
    formatDuration,
    formatTitle,
    getAlbum,
    getFullAlbumInfo,
    getType,
    isThxSpatialAudio,
    QobuzAlbum,
    QobuzArtist,
    QobuzTrack
} from '@/lib/qobuz-dl';
import { filterData } from '@/app/search-view';
import { motion, useAnimation } from 'motion/react';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { Skeleton } from './ui/skeleton';
import { useFFmpeg } from '@/lib/ffmpeg-provider';
import { useSettings } from '@/lib/settings-provider';
import { useStatusBar } from '@/lib/status-bar/context';
import { useToast } from '@/hooks/use-toast';
import { useCountry } from '@/lib/country-provider';
import { usePlayer } from '@/lib/player-provider';

const ReleaseCard = ({
    result,
    resolvedTheme,
    ref,
    showArtistDialog
}: {
    result: QobuzAlbum | QobuzTrack | QobuzArtist;
    resolvedTheme: string;
    ref?: React.Ref<HTMLDivElement>;
    showArtistDialog?: boolean;
}) => {
    if (typeof showArtistDialog === 'undefined') showArtistDialog = true;
    const { ffmpegState } = useFFmpeg();
    const { setStatusBar } = useStatusBar();
    const { settings } = useSettings();
    const { source } = useSource();
    const { showHandoff } = useAppleHandoff();

    const [openTracklist, setOpenTracklist] = useState(false);
    const [fetchedAlbumData, setFetchedAlbumData] = useState<FetchedQobuzAlbum | null>(null);
    const [focusCard, setFocusCard] = useState(false);

    const { toast } = useToast();

    const album = getAlbum(result) || null;

    const [imageLoaded, setImageLoaded] = useState(false);
    const imageAnimationControls = useAnimation();

    const artist = (result as QobuzAlbum).artist ?? (result as QobuzTrack).performer ?? (result as QobuzTrack).composer;

    useEffect(() => {
        if (imageLoaded) imageAnimationControls.start({ scale: 1 });
    }, [imageLoaded]);

    const [openArtistDialog, setOpenArtistDialog] = useState(false);
    const { country } = useCountry();
    const { playTracks, playAlbum } = usePlayer();
    const [startingPlayback, setStartingPlayback] = useState(false);

    // Qobuz and TIDAL stream full tracks and Deezer plays 30-second previews. Apple
    // audio is DRM-encrypted and handed off to the native app instead.
    const sourceCanStream = source === 'qobuz' || source === 'deezer' || source === 'tidal';
    const canStream = sourceCanStream && getType(result) !== 'artists' && (result as QobuzAlbum | QobuzTrack).streamable !== false;
    // Deezer has full-length downloads via its ARL session, so its cards get a real
    // download button; Apple gets the Tryptify handoff; Qobuz/TIDAL get the ZIP dropdown.
    const deezerLink = (result as { deezer?: DeezerExtras }).deezer?.link;

    const playResult = async () => {
        if ((result as QobuzTrack).album) {
            playTracks([result as QobuzTrack]);
            return;
        }
        setStartingPlayback(true);
        try {
            await playAlbum(result as QobuzAlbum);
        } catch {
            toast({ title: 'Playback failed', description: `Couldn't load '${formatTitle(result)}' for streaming.` });
        } finally {
            setStartingPlayback(false);
        }
    };

    return (
        <div className='space-y-2' title={formatTitle(result)} ref={ref || undefined}>
            <div className='relative w-full aspect-square group select-none rounded-sm overflow-hidden'>
                <div
                    className={cn(
                        `w-full z-[3] backdrop-blur-md top-0 left-0 absolute transition-all aspect-square opacity-0 group-hover:opacity-100 ${focusCard && 'opacity-100'}`,
                        resolvedTheme != 'light'
                            ? `group-hover:bg-black/40 ${focusCard && 'bg-black/40'}`
                            : `group-hover:bg-white/20 ${focusCard && 'bg-white/20'}`
                    )}
                    onClick={() => {
                        if (getType(result) === 'artists') setOpenArtistDialog(true);
                    }}
                >
                    <div className='flex flex-col h-full justify-between'>
                        <div className='space-y-0.5 p-4 flex justify-between relative overflow-x-hidden'>
                            <div className='w-full pr-9'>
                                <p className='text-sm truncate capitalize font-bold'>
                                    {!(getType(result) === 'artists') ? album.genre.name : (result as QobuzArtist).albums_count + ' Releases'}
                                </p>
                                {!(getType(result) === 'artists') && album.released_at > 0 && (
                                    <p className='text-xs truncate capitalize font-medium'>{new Date(album.released_at * 1000).getFullYear()}</p>
                                )}
                                {!(getType(result) === 'artists') && (
                                    <div className='flex text-[10px] truncate font-semibold items-center justify-start'>
                                        <p>{(result as QobuzAlbum | QobuzTrack).maximum_bit_depth}-bit</p>
                                        <DotIcon size={16} />
                                        <p>{(result as QobuzAlbum | QobuzTrack).maximum_sampling_rate} kHz</p>
                                    </div>
                                )}
                                <div className='flex text-[10px] truncate font-semibold items-center justify-start'>
                                    {(result as QobuzAlbum).tracks_count ? (
                                        <>
                                            <p>
                                                {(result as QobuzAlbum).tracks_count} {(result as QobuzAlbum).tracks_count > 1 ? 'tracks' : 'track'}
                                            </p>
                                            <DotIcon size={16} />
                                        </>
                                    ) : null}
                                    {!(getType(result) === 'artists') && <p>{formatDuration((result as QobuzAlbum | QobuzTrack).duration)}</p>}
                                </div>
                            </div>
                            {getType(result) !== 'artists' && showArtistDialog && (
                                <div className='absolute top-0 right-0 p-4'>
                                    <Button
                                        size='icon'
                                        variant='ghost'
                                        className='aspect-square'
                                        onClick={async () => {
                                            setOpenArtistDialog(true);
                                        }}
                                    >
                                        <UsersIcon />
                                    </Button>
                                </div>
                            )}
                        </div>
                        {!(getType(result) === 'artists') && (
                            <div className='flex items-center justify-between gap-4 p-2'>
                                {source === 'apple' && deezerLink ? (
                                    <Button size='icon' variant='ghost' title='Open in Apple Music' asChild>
                                        <a href={deezerLink} target='_blank' rel='noopener noreferrer'>
                                            <ExternalLinkIcon />
                                        </a>
                                    </Button>
                                ) : (result as QobuzTrack).album ? (
                                    <Button
                                        size='icon'
                                        variant='ghost'
                                        onClick={async () => {
                                            if (source === 'apple')
                                                await createAppleDownloadJob(
                                                    result as QobuzTrack,
                                                    setStatusBar,
                                                    settings,
                                                    toast as any,
                                                    showHandoff,
                                                    country,
                                                    fetchedAlbumData,
                                                    setFetchedAlbumData
                                                );
                                            else
                                                await createDownloadJob(
                                                    result as QobuzTrack,
                                                    setStatusBar,
                                                    ffmpegState!,
                                                    settings,
                                                    toast as any,
                                                    fetchedAlbumData,
                                                    setFetchedAlbumData,
                                                    country
                                                );
                                        }}
                                    >
                                        <DownloadIcon />
                                    </Button>
                                ) : (
                                    <DownloadAlbumButton
                                        variant='ghost'
                                        size='icon'
                                        result={result as QobuzAlbum}
                                        toast={toast}
                                        setStatusBar={setStatusBar}
                                        ffmpegState={ffmpegState!}
                                        settings={settings}
                                        fetchedAlbumData={fetchedAlbumData}
                                        setFetchedAlbumData={setFetchedAlbumData}
                                        onOpen={() => setFocusCard(true)}
                                        onClose={() => setFocusCard(false)}
                                        source={source}
                                        showHandoff={showHandoff}
                                    />
                                )}
                                {canStream && (
                                    <Button size='icon' variant='ghost' title={`Play '${formatTitle(result)}'`} onClick={playResult} disabled={startingPlayback}>
                                        {startingPlayback ? <Loader2Icon className='animate-spin' /> : <PlayIcon />}
                                    </Button>
                                )}
                                {(result as QobuzTrack).album ? null : (
                                    <Button
                                        size='icon'
                                        variant='ghost'
                                        onClick={async () => {
                                            setOpenTracklist(!openTracklist);
                                            if (source === 'apple')
                                                await getFullAppleAlbumInfo(fetchedAlbumData, setFetchedAlbumData, result as QobuzAlbum, country);
                                            else if (source === 'deezer') await getFullDeezerAlbumInfo(fetchedAlbumData, setFetchedAlbumData, result as QobuzAlbum);
                                            else if (source === 'tidal') await getFullTidalAlbumInfo(fetchedAlbumData, setFetchedAlbumData, result as QobuzAlbum);
                                            else await getFullAlbumInfo(fetchedAlbumData, setFetchedAlbumData, result as QobuzAlbum, country);
                                        }}
                                    >
                                        <AlignJustifyIcon />
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
                <motion.div
                    initial={(album || result).image?.small ? { scale: 0.9 } : { scale: 1 }}
                    animate={imageAnimationControls}
                    transition={{ duration: 0.1 }}
                    className={cn('absolute left-0 top-0 z-[2] w-full aspect-square transition-all')}
                >
                    {(album || result).image?.small ? (
                        <>
                            {getType(result) === 'artists' ? (
                                <Image
                                    fill
                                    src={(album || result).image?.small}
                                    alt={formatTitle(result)}
                                    className={cn(
                                        'object-cover group-hover:scale-105 transition-all w-full h-full text-[0px]',
                                        focusCard && 'scale-105',
                                        imageLoaded && 'opacity-100'
                                    )}
                                    sizes='(min-width: 1280px) calc((100vw - 96px) / 7), (min-width: 1024px) calc((100vw - 80px) / 6), (min-width: 768px) calc((100vw - 64px) / 5), (min-width: 640px) calc((100vw - 48px) / 3), calc((100vw - 32px) / 2)'
                                    onLoad={() => {
                                        setImageLoaded(true);
                                    }}
                                />
                            ) : (
                                <img
                                    crossOrigin='anonymous'
                                    src={(album || result).image?.small}
                                    alt={formatTitle(result)}
                                    className={cn(
                                        'object-cover group-hover:scale-105 transition-all w-full h-full text-[0px]',
                                        focusCard && 'scale-105',
                                        imageLoaded && 'opacity-100'
                                    )}
                                    sizes='(min-width: 1280px) calc((100vw - 96px) / 7), (min-width: 1024px) calc((100vw - 80px) / 6), (min-width: 768px) calc((100vw - 64px) / 5), (min-width: 640px) calc((100vw - 48px) / 3), calc((100vw - 32px) / 2)'
                                    onLoad={() => {
                                        setImageLoaded(true);
                                    }}
                                />
                            )}
                        </>
                    ) : (
                        <motion.div className='flex items-center justify-center bg-secondary w-full h-full' initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                            {filterData.map((filter, index) => {
                                if (filter.value === getType(result)) {
                                    return <filter.icon key={index} className='w-1/2 h-1/2 opacity-20' />;
                                }
                            })}
                        </motion.div>
                    )}
                </motion.div>
                <Skeleton className='absolute left-0 top-0 z-[1] w-full aspect-square flex items-center justify-center' />
            </div>
            <div className='space-y-1'>
                <div className='flex gap-1.5 items-center'>
                    <SourceTag item={result} />
                    {(result as QobuzAlbum | QobuzTrack).parental_warning && (
                        <p
                            className='text-[10px] bg-primary text-primary-foreground p-1 rounded-[3px] aspect-square w-[18px] h-[18px] text-center justify-center items-center shrink-0 flex font-semibold'
                            title='Explicit'
                        >
                            E
                        </p>
                    )}
                    {isThxSpatialAudio(result) && (
                        <p
                            className='text-[10px] bg-primary text-primary-foreground p-1 rounded-[3px] h-[18px] text-center justify-center items-center shrink-0 flex font-semibold'
                            title='THX Spatial Audio'
                        >
                            THX
                        </p>
                    )}
                    {isTidalAtmos(result) && <DolbyAtmosBadge />}
                    <h1 className='text-sm truncate font-bold group-hover:underline'>{formatTitle(result)}</h1>
                </div>
                {!(getType(result) === 'artists') && (
                    <div className='text-xs truncate flex gap-x-0.5 items-center' title={formatArtists(result as QobuzAlbum | QobuzTrack)}>
                        <UsersIcon className='size-3.5 shrink-0' />
                        <span className='truncate'>{formatArtists(result as QobuzAlbum | QobuzTrack)}</span>
                    </div>
                )}
                {(result as QobuzTrack).album?.title ? (
                    <div className='text-xs truncate flex gap-x-0.5 items-center'>
                        <DiscAlbumIcon className='size-3.5 shrink-0' />
                        <span className='truncate'>{(result as QobuzTrack).album.title}</span>
                    </div>
                ) : null}
            </div>
            {getType(result) === 'artists' && <ArtistDialog open={openArtistDialog} setOpen={setOpenArtistDialog} artist={result as QobuzArtist} />}
            <Dialog open={openTracklist} onOpenChange={setOpenTracklist}>
                <DialogContent className='w-[600px] max-w-[90%] md:max-w-[80%] overflow-hidden'>
                    <div className='flex gap-3 overflow-hidden'>
                        <div className='relative shrink-0 aspect-square min-w-[100px] min-h-[100px] rounded-sm overflow-hidden'>
                            <Skeleton className='absolute aspect-square w-full h-full' />
                            {(album || result).image?.small && (
                                <img
                                    src={(album || result).image?.small}
                                    alt={formatTitle(result)}
                                    crossOrigin='anonymous'
                                    className='absolute aspect-square w-full h-full'
                                />
                            )}
                        </div>

                        <div className='flex w-full flex-col justify-between overflow-hidden'>
                            <div className='space-y-1.5 overflow-visible'>
                                <DialogTitle title={formatTitle(album || result)} className='truncate overflow-visible py-0.5 pr-2'>
                                    {formatTitle(album || result)}
                                </DialogTitle>
                                {!(getType(result) === 'artists') && (
                                    <DialogDescription title={formatArtists(result as QobuzAlbum | QobuzTrack)} className='truncate overflow-visible '>
                                        {formatArtists(result as QobuzAlbum | QobuzTrack)}
                                    </DialogDescription>
                                )}
                            </div>
                            <div className='flex items-center w-full justify-between gap-2'>
                                <div className='space-y-1.5 w-fit'>
                                    {!(getType(result) === 'artists') && (
                                        <DialogDescription className='truncate'>
                                            {album.tracks_count} {album.tracks_count > 1 ? 'tracks' : 'track'} - {formatDuration(album.duration)}
                                        </DialogDescription>
                                    )}
                                </div>
                                <DownloadAlbumButton
                                    result={result as QobuzAlbum}
                                    toast={toast}
                                    setStatusBar={setStatusBar}
                                    ffmpegState={ffmpegState!}
                                    settings={settings}
                                    fetchedAlbumData={fetchedAlbumData}
                                    setFetchedAlbumData={setFetchedAlbumData}
                                    variant='ghost'
                                    size='icon'
                                    source={source}
                                    showHandoff={showHandoff}
                                    onClick={() => {
                                        setOpenTracklist(false);
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                    <Separator />
                    {fetchedAlbumData && (
                        <ScrollArea className='max-h-[40vh]'>
                            <motion.div initial={{ maxHeight: '0vh' }} animate={{ maxHeight: '40vh' }}>
                                <div className='flex flex-col overflow-hidden pr-3'>
                                    {fetchedAlbumData.tracks.items.map((track: QobuzTrack, index: number) => {
                                        track.album = album;
                                        return (
                                            <div key={track.id}>
                                                <div
                                                    className={cn(
                                                        'flex items-center justify-between gap-2 overflow-hidden hover:bg-primary/5 transition-all p-2 rounded group',
                                                        !track.streamable && 'opacity-50'
                                                    )}
                                                >
                                                    <div className='gap-2 flex items-center overflow-hidden'>
                                                        <span className='text-muted-foreground text-sm'>{index + 1}</span>
                                                        {track.parental_warning && (
                                                            <p
                                                                className='text-[10px] bg-primary text-primary-foreground p-1 rounded-[3px] aspect-square w-[18px] h-[18px] shrink-0 text-center justify-center items-center flex font-semibold'
                                                                title='Explicit'
                                                            >
                                                                E
                                                            </p>
                                                        )}
                                                        {isThxSpatialAudio(track) && (
                                                            <p
                                                                className='text-[10px] bg-primary text-primary-foreground p-1 rounded-[3px] h-[18px] shrink-0 text-center justify-center items-center flex font-semibold'
                                                                title='THX Spatial Audio'
                                                            >
                                                                THX
                                                            </p>
                                                        )}
                                                        {isTidalAtmos(track) && <DolbyAtmosBadge />}
                                                        <p className='truncate font-medium'>{formatTitle(track)}</p>
                                                    </div>
                                                    {track.streamable && sourceCanStream && (
                                                        <Button
                                                            title={`Play '${formatTitle(track)}'`}
                                                            className='md:group-hover:flex md:hidden justify-center aspect-square h-6 w-6 [&_svg]:size-5 hover:bg-transparent ml-auto'
                                                            size='icon'
                                                            variant='ghost'
                                                            onClick={() => playTracks(fetchedAlbumData.tracks.items, index)}
                                                        >
                                                            <PlayIcon className='!size-4' />
                                                        </Button>
                                                    )}
                                                    {track.streamable && (
                                                        <Button
                                                            title={`Download '${formatTitle(track)}'`}
                                                            className='md:group-hover:flex md:hidden justify-center aspect-square h-6 w-6 [&_svg]:size-5 hover:bg-transparent'
                                                            size='icon'
                                                            variant='ghost'
                                                            onClick={async () => {
                                                                if (source === 'apple')
                                                                    await createAppleDownloadJob(track, setStatusBar, settings, toast as any, showHandoff, country);
                                                                else
                                                                    await createDownloadJob(
                                                                        track,
                                                                        setStatusBar,
                                                                        ffmpegState!,
                                                                        settings,
                                                                        toast as any,
                                                                        undefined,
                                                                        undefined,
                                                                        country
                                                                    );
                                                                toast({
                                                                    title: `Added '${formatTitle(track)}' to the queue`,
                                                                    description: 'Track has been added to the queue'
                                                                });
                                                            }}
                                                        >
                                                            <DownloadIcon className='!size-4' />
                                                        </Button>
                                                    )}
                                                </div>
                                                {index < fetchedAlbumData.tracks.items.length - 1 && <Separator />}
                                                <div />
                                            </div>
                                        );
                                    })}
                                </div>
                            </motion.div>
                        </ScrollArea>
                    )}
                </DialogContent>
            </Dialog>
            {getType(result) !== 'artists' && showArtistDialog && <ArtistDialog open={openArtistDialog} setOpen={setOpenArtistDialog} artist={artist} />}
        </div>
    );
};

export default ReleaseCard;
