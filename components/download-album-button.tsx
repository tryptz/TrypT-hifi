import React, { useEffect, useState } from 'react';
import { Button, ButtonProps } from './ui/button';
import { DownloadIcon, FileArchiveIcon, MusicIcon } from 'lucide-react';
import { StatusBarProps } from './status-bar/status-bar';
import { FFmpegType } from '@/lib/ffmpeg-functions';
import { SettingsProps } from '@/lib/settings-provider';
import { FetchedQobuzAlbum, formatTitle, getFullAlbumInfo, QobuzAlbum } from '@/lib/qobuz-dl';
import { createDownloadJob, DownloadOptions } from '@/lib/download-job';
import { createAppleDownloadJob } from '@/lib/apple-download-job';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { DolbyMark } from './dolby-atmos-badge';
import { getFullTidalAlbumInfo, isTidalAtmos } from '@/lib/tidal';
import { getFullDeezerAlbumInfo } from '@/lib/deezer';
import { useCountry } from '@/lib/country-provider';
import { MusicSource } from '@/lib/source-provider';
import { HandoffPayload } from '@/lib/apple-handoff-provider';

export interface DownloadAlbumButtonProps extends ButtonProps {
    result: QobuzAlbum;
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>;
    ffmpegState: FFmpegType;
    settings: SettingsProps;
    fetchedAlbumData: FetchedQobuzAlbum | null;
    setFetchedAlbumData: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>;
    onOpen?: () => void;
    onClose?: () => void;
    toast: (toast: any) => void;
    source?: MusicSource;
    showHandoff?: (payload: HandoffPayload) => void;
}

const DownloadButton = React.forwardRef<HTMLButtonElement, DownloadAlbumButtonProps>(
    (
        {
            className,
            variant,
            size,
            asChild = false,
            onOpen,
            onClose,
            result,
            setStatusBar,
            ffmpegState,
            settings,
            toast,
            fetchedAlbumData,
            setFetchedAlbumData,
            source,
            showHandoff,
            ...props
        },
        ref
    ) => {
        const { country } = useCountry();
        const [open, setOpen] = useState(false);
        useEffect(() => {
            if (open) onOpen?.();
            else onClose?.();
        });
        if (source === 'apple' && showHandoff) {
            // Apple: no zip/no-zip distinction — resolve the album's manifests and
            // hand the batch to Tryptify.
            return (
                <Button
                    className={className}
                    ref={ref}
                    variant={variant}
                    size={size}
                    asChild={asChild}
                    {...props}
                    onClick={(e) => {
                        (props as any).onClick?.(e);
                        createAppleDownloadJob(result, setStatusBar, settings, toast, showHandoff, country, fetchedAlbumData, setFetchedAlbumData);
                        toast({ title: `Added '${formatTitle(result)}'`, description: 'Resolving manifests for the Tryptify handoff' });
                    }}
                >
                    <DownloadIcon className='!size-4' />
                </Button>
            );
        }
        // The album's full track list, from its own service: a TIDAL or Deezer id
        // asked of Qobuz's /api/get-album names some other album.
        const loadAlbum = () =>
            source === 'tidal'
                ? getFullTidalAlbumInfo(fetchedAlbumData, setFetchedAlbumData, result)
                : source === 'deezer'
                  ? getFullDeezerAlbumInfo(fetchedAlbumData, setFetchedAlbumData, result)
                  : getFullAlbumInfo(fetchedAlbumData, setFetchedAlbumData, result, country);
        const added = (options: DownloadOptions) =>
            toast({
                title: `Added '${formatTitle(result)}'`,
                description: options.atmos ? 'The album has been added to the queue in Dolby Atmos (.m4a)' : 'The album has been added to the queue'
            });
        const downloadZip = (options: DownloadOptions = {}) => {
            createDownloadJob(result, setStatusBar, ffmpegState, settings, toast, fetchedAlbumData, setFetchedAlbumData, country, options);
            added(options);
        };
        const downloadTracks = async (options: DownloadOptions = {}) => {
            const albumData = await loadAlbum();
            for (const track of albumData.tracks.items) {
                if (track.streamable) {
                    await createDownloadJob(
                        { ...track, album: albumData },
                        setStatusBar,
                        ffmpegState,
                        settings,
                        toast,
                        albumData,
                        setFetchedAlbumData,
                        country,
                        options
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            added(options);
        };
        return (
            <>
                <DropdownMenu open={open} onOpenChange={setOpen}>
                    <DropdownMenuTrigger asChild>
                        <Button className={className} ref={ref} variant={variant} size={size} asChild={asChild} {...props}>
                            <DownloadIcon className='!size-4' />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                        <DropdownMenuItem onClick={() => downloadZip()} className='flex items-center gap-2'>
                            <FileArchiveIcon className='!size-4' />
                            <p>ZIP Archive</p>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => downloadTracks()} className='flex items-center gap-2'>
                            <MusicIcon className='!size-4' />
                            <p>No ZIP Archive</p>
                        </DropdownMenuItem>
                        {isTidalAtmos(result) && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => downloadZip({ atmos: true })} className='flex items-center gap-2'>
                                    <DolbyMark className='!w-4 !h-3' />
                                    <p>Dolby Atmos (.m4a), ZIP Archive</p>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => downloadTracks({ atmos: true })} className='flex items-center gap-2'>
                                    <DolbyMark className='!w-4 !h-3' />
                                    <p>Dolby Atmos (.m4a), No ZIP Archive</p>
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </>
        );
    }
);
DownloadButton.displayName = 'DownloadAlbumButton';

export default DownloadButton;
