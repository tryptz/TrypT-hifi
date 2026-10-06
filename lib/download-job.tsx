import axios, { AxiosError } from 'axios';
import saveAs from 'file-saver';
import { applyMetadata, codecMap, FFmpegType, fixMD5Hash, loadFFmpeg } from './ffmpeg-functions';
import { artistReleaseCategories } from '@/components/artist-dialog';
import { cleanFileName, formatBytes, formatCustomTitle, resizeImage } from './utils';
import { createJob } from './status-bar/jobs';
import { Disc3Icon, DiscAlbumIcon } from 'lucide-react';
import { FetchedQobuzAlbum, formatTitle, getFullResImageUrl, QobuzAlbum, QobuzArtistResults, QobuzTrack } from './qobuz-dl';
import { SettingsProps } from './settings-provider';
import { StatusBarProps } from '@/components/status-bar/status-bar';
import { ToastAction } from '@/components/ui/toast';
import { zipSync } from 'fflate';
import { isTidalAtmos, isTidalItem } from './tidal';
import { isDeezerItem } from './deezer';

// TIDAL releases download through /api/tidal/*, which mirrors the Qobuz routes
// (same quality ids, same signed-link response), so only the base path differs.
// Deezer tracks download through /api/deezer/* the same way.
const apiBaseFor = (item: QobuzAlbum | QobuzTrack) => (isTidalItem(item) ? '/api/tidal' : isDeezerItem(item) ? '/api/deezer' : '/api');

export type DownloadOptions = {
    // "Dolby Atmos (.m4a)": TIDAL tracks with an Atmos mix download that mix or
    // fail saying why, never the stereo file in its place. Tracks without one
    // (on an Atmos album) download in the stereo settings.
    atmos?: boolean;
};

// The server's own reason for a failed request ({ success: false, error }).
const serverError = (e: unknown) =>
    (e instanceof AxiosError && typeof e.response?.data?.error === 'string' && e.response.data.error) || (e instanceof Error ? e.message : String(e));

// Resolves a track's file URL. With "Prefer Dolby Atmos" on, TIDAL tracks that have
// an Atmos mix try the Atmos file first and fall back to the stereo quality when
// TIDAL won't serve it (e.g. DRM-protected); asked for outright (forceAtmos) they
// do not fall back. Atmos files are E-AC-3 JOC .m4a and must be saved untouched:
// re-encoding or remuxing would lose the Atmos data.
async function resolveTrackURL(track: QobuzTrack, settings: SettingsProps, country: string | undefined, signal: AbortSignal, forceAtmos = false) {
    if ((forceAtmos || settings.tidalAtmos) && isTidalAtmos(track)) {
        try {
            const response = await axios.get('/api/tidal/download-music', { params: { track_id: track.id, atmos: 'true' }, signal });
            return { url: response.data.data.url as string, atmos: true };
        } catch (e) {
            if (e instanceof AxiosError && e.code === 'ERR_CANCELED') throw e;
            if (forceAtmos) throw new Error(`No Dolby Atmos file for "${formatTitle(track)}": ${serverError(e)}`);
        }
    }
    const response = await axios.get(`${apiBaseFor(track)}/download-music`, {
        headers: { 'Token-Country': country },
        params: { track_id: track.id, quality: settings.outputQuality },
        signal
    });
    return { url: response.data.data.url as string, atmos: false };
}

const ATMOS_EXTENSION = 'm4a';

export const createDownloadJob = async (
    result: QobuzAlbum | QobuzTrack,
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    ffmpegState: FFmpegType,
    settings: SettingsProps,
    toast: (toast: any) => void,
    fetchedAlbumData?: FetchedQobuzAlbum | null,
    setFetchedAlbumData?: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>,
    country?: string,
    options: DownloadOptions = {}
) => {
    if ((result as QobuzTrack).album) {
        const formattedTitle = formatCustomTitle(settings.trackName, result as QobuzTrack);
        await createJob(setStatusBar, formattedTitle, Disc3Icon, async () => {
            return new Promise(async (resolve) => {
                try {
                    const controller = new AbortController();
                    const signal = controller.signal;
                    let cancelled = false;
                    setStatusBar((prev) => ({
                        ...prev,
                        progress: 0,
                        title: `Downloading ${formatTitle(result)}`,
                        description: `Loading FFmpeg`,
                        onCancel: () => {
                            cancelled = true;
                            controller.abort();
                        }
                    }));
                    // An Atmos file is saved untouched, so it needs no FFmpeg.
                    const atmosOnly = options.atmos && isTidalAtmos(result);
                    if (
                        !atmosOnly &&
                        (settings.applyMetadata ||
                            !(
                                (settings.outputQuality === '27' && settings.outputCodec === 'FLAC') ||
                                (settings.bitrate === 320 && settings.outputCodec === 'MP3')
                            ))
                    )
                        await loadFFmpeg(ffmpegState);
                    setStatusBar((prev) => ({ ...prev, description: 'Fetching track size...' }));
                    const { url: trackURL, atmos } = await resolveTrackURL(result as QobuzTrack, settings, country, signal, options.atmos);
                    const fileSizeResponse = await axios.head(trackURL, { signal });
                    const fileSize = fileSizeResponse.headers['content-length'];
                    const response = await axios.get(trackURL, {
                        responseType: 'arraybuffer',
                        onDownloadProgress: (progressEvent) => {
                            setStatusBar((statusbar) => {
                                if (statusbar.processing && !cancelled)
                                    return {
                                        ...statusbar,
                                        progress: Math.floor((progressEvent.loaded / fileSize) * 100),
                                        description: `${formatBytes(progressEvent.loaded)} / ${formatBytes(fileSize)}`
                                    };
                                else return statusbar;
                            });
                        },
                        signal
                    });
                    if (atmos) {
                        // Saved as-is; browsers without E-AC-3 can't load it, so the duration check below is skipped too.
                        proceedDownload(URL.createObjectURL(new Blob([response.data])), formattedTitle + '.' + ATMOS_EXTENSION);
                        resolve();
                        return;
                    }
                    setStatusBar((prev) => ({ ...prev, description: `Applying metadata...`, progress: 100 }));
                    const inputFile = response.data;
                    const outputFile = await applyMetadata(inputFile, result as QobuzTrack, ffmpegState, settings, setStatusBar);
                    let finalData: ArrayBuffer | Uint8Array | Blob = outputFile;
                    if (settings.outputCodec === 'FLAC' && settings.fixMD5) finalData = await fixMD5Hash(outputFile, setStatusBar);
                    const objectURL = URL.createObjectURL(new Blob([finalData]));
                    const title = formattedTitle + '.' + codecMap[settings.outputCodec].extension;
                    const audioElement = document.createElement('audio');
                    audioElement.id = `track_${result.id}`;
                    audioElement.src = objectURL;
                    audioElement.onloadedmetadata = function () {
                        if (Math.round(audioElement.duration) >= Math.round(result.duration)) {
                            proceedDownload(objectURL, title);
                            resolve();
                        } else {
                            toast({
                                title: 'Error',
                                description: `${isTidalItem(result) ? 'TIDAL' : 'Qobuz'} provided a file shorter than expected for "${title}". This can indicate the file being a sample track rather than the full track`,
                                duration: Infinity,
                                action: (
                                    <ToastAction
                                        altText='Copy Stack'
                                        onClick={() => {
                                            proceedDownload(objectURL, title);
                                        }}
                                    >
                                        Download anyway
                                    </ToastAction>
                                )
                            });
                            resolve();
                        }
                    };
                    document.body.append(audioElement);
                } catch (e) {
                    if (e instanceof AxiosError && e.code === 'ERR_CANCELED') resolve();
                    else {
                        toast({
                            title: 'Error',
                            description: e instanceof Error ? e.message : 'An unknown error occurred',
                            action: (
                                <ToastAction altText='Copy Stack' onClick={() => navigator.clipboard.writeText((e as Error).stack!)}>
                                    Copy Stack
                                </ToastAction>
                            )
                        });
                        resolve();
                    }
                }
            });
        });
    } else {
        const formattedZipTitle = formatCustomTitle(settings.zipName, result as QobuzAlbum);

        await createJob(setStatusBar, formattedZipTitle, DiscAlbumIcon, async () => {
            return new Promise(async (resolve) => {
                try {
                    const controller = new AbortController();
                    const signal = controller.signal;
                    let cancelled = false;
                    setStatusBar((prev) => ({
                        ...prev,
                        progress: 0,
                        title: `Downloading ${formatTitle(result)}`,
                        description: `Loading FFmpeg...`,
                        onCancel: () => {
                            cancelled = true;
                            controller.abort();
                        }
                    }));
                    if (
                        settings.applyMetadata ||
                        !((settings.outputQuality === '27' && settings.outputCodec === 'FLAC') || (settings.bitrate === 320 && settings.outputCodec === 'MP3'))
                    )
                        await loadFFmpeg(ffmpegState);
                    setStatusBar((prev) => ({ ...prev, description: 'Fetching album data...' }));
                    if (!fetchedAlbumData) {
                        const albumDataResponse = await axios.get(`${apiBaseFor(result)}/get-album`, {
                            params: { album_id: (result as QobuzAlbum).id },
                            headers: { 'Token-Country': country },
                            signal
                        });
                        if (setFetchedAlbumData) {
                            setFetchedAlbumData(albumDataResponse.data.data);
                        }
                        fetchedAlbumData = albumDataResponse.data.data;
                    }
                    const albumTracks = fetchedAlbumData!.tracks.items.map((track: QobuzTrack) => ({
                        ...track,
                        album: fetchedAlbumData
                    })) as QobuzTrack[];
                    let totalAlbumSize = 0;
                    const albumUrls = [] as string[];
                    // Parallel to albumUrls: whether that slot is an untouched Atmos file.
                    const albumAtmos = [] as boolean[];
                    setStatusBar((prev) => ({ ...prev, description: 'Fetching album size...' }));
                    let currentDisk = 1;
                    let trackOffset = 0;
                    for (let index = 0; index < albumTracks.length; index++) {
                        const track = albumTracks[index];
                        if (track.streamable) {
                            const { url: trackURL, atmos } = await resolveTrackURL(track, settings, country, signal, options.atmos);
                            let slot: number;
                            if (!(currentDisk === track.media_number)) {
                                trackOffset = albumUrls.length;
                                currentDisk = track.media_number;
                                slot = albumUrls.length;
                            } else slot = track.track_number + trackOffset - 1;
                            albumUrls[slot] = trackURL;
                            albumAtmos[slot] = atmos;
                            const fileSizeResponse = await axios.head(trackURL, { signal });
                            setStatusBar((statusBar) => ({
                                ...statusBar,
                                progress: (100 / albumTracks.length) * (index + 1)
                            }));
                            const fileSize = parseInt(fileSizeResponse.headers['content-length']);
                            totalAlbumSize += fileSize;
                        }
                    }
                    const trackBuffers = [] as (ArrayBuffer | Uint8Array)[];
                    let totalBytesDownloaded = 0;
                    setStatusBar((statusBar) => ({ ...statusBar, progress: 0, description: `Fetching album art...` }));
                    const albumArtURL = await resizeImage(getFullResImageUrl(fetchedAlbumData!), settings.albumArtSize, settings.albumArtQuality);
                    const albumArt = albumArtURL ? (await axios.get(albumArtURL, { responseType: 'arraybuffer' })).data : false;
                    for (let index = 0; index < albumUrls.length; index++) {
                        const url = albumUrls[index];
                        if (url) {
                            const response = await axios.get(url, {
                                responseType: 'arraybuffer',
                                onDownloadProgress: (progressEvent) => {
                                    if (totalBytesDownloaded + progressEvent.loaded < totalAlbumSize)
                                        setStatusBar((statusBar) => {
                                            if (statusBar.processing && !cancelled)
                                                return {
                                                    ...statusBar,
                                                    progress: Math.floor(((totalBytesDownloaded + progressEvent.loaded) / totalAlbumSize) * 100),
                                                    description: `${formatBytes(totalBytesDownloaded + progressEvent.loaded)} / ${formatBytes(totalAlbumSize)}`
                                                };
                                            else return statusBar;
                                        });
                                },
                                signal
                            });
                            await new Promise((resolve) => setTimeout(resolve, 100));
                            totalBytesDownloaded += response.data.byteLength;
                            if (albumAtmos[index]) {
                                trackBuffers[index] = response.data;
                                continue;
                            }
                            const inputFile = response.data;
                            let outputFile = await applyMetadata(
                                inputFile,
                                albumTracks[index],
                                ffmpegState,
                                settings,
                                undefined,
                                albumArt,
                                fetchedAlbumData!.upc
                            );
                            if (settings.outputCodec === 'FLAC' && settings.fixMD5) outputFile = await (await fixMD5Hash(outputFile)).arrayBuffer();
                            trackBuffers[index] = outputFile;
                        }
                    }
                    setStatusBar((statusBar) => ({ ...statusBar, progress: 0, description: `Zipping album...` }));
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    const zipFiles = {
                        'cover.jpg': albumArt ? new Uint8Array(albumArt) : new Uint8Array(0),
                        ...trackBuffers.reduce(
                            (acc, buffer, index) => {
                                if (buffer) {
                                    const extension = albumAtmos[index] ? ATMOS_EXTENSION : codecMap[settings.outputCodec].extension;
                                    const fileName = `${(index + 1).toString().padStart(Math.max(String(albumTracks.length - 1).length, 2), '0')} ${formatCustomTitle(settings.trackName, albumTracks[index])}.${extension}`;

                                    acc[cleanFileName(fileName)] = new Uint8Array(buffer);
                                }
                                return acc;
                            },
                            {} as { [key: string]: Uint8Array }
                        )
                    } as { [key: string]: Uint8Array };
                    if (albumArt === false) delete zipFiles['cover.jpg'];
                    const zippedFile = zipSync(zipFiles, { level: 0 });
                    const zipBlob = new Blob([zippedFile as BlobPart], { type: 'application/zip' });
                    setStatusBar((prev) => ({ ...prev, progress: 100 }));
                    const objectURL = URL.createObjectURL(zipBlob);
                    saveAs(objectURL, formattedZipTitle + '.zip');
                    setTimeout(() => {
                        URL.revokeObjectURL(objectURL);
                    }, 100);
                    resolve();
                } catch (e) {
                    if (e instanceof AxiosError && e.code === 'ERR_CANCELED') resolve();
                    else {
                        toast({
                            title: 'Error',
                            description: e instanceof Error ? e.message : 'An unknown error occurred',
                            action: (
                                <ToastAction altText='Copy Stack' onClick={() => navigator.clipboard.writeText((e as Error).stack!)}>
                                    Copy Stack
                                </ToastAction>
                            )
                        });
                        resolve();
                    }
                }
            });
        });
    }
};

function proceedDownload(objectURL: string, title: string) {
    saveAs(objectURL, title);
    setTimeout(() => {
        URL.revokeObjectURL(objectURL);
    }, 100);
}

export async function downloadArtistDiscography(
    artistResults: QobuzArtistResults,
    setArtistResults: React.Dispatch<React.SetStateAction<QobuzArtistResults | null>>,
    fetchMore: (searchField: any, artistResults: QobuzArtistResults) => Promise<void>,
    type: 'album' | 'epSingle' | 'live' | 'compilation' | 'all',
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    settings: SettingsProps,
    toast: (toast: any) => void,
    ffmpegState: FFmpegType,
    country?: string
) {
    let types: ('album' | 'epSingle' | 'live' | 'compilation')[] = [];
    if (type === 'all') types = ['album', 'epSingle', 'live', 'compilation'];
    else types = [type];
    for (const type of types) {
        while (artistResults.artist.releases[type].has_more) {
            await fetchMore(type, artistResults);
            artistResults = (await loadArtistResults(setArtistResults)) as QobuzArtistResults;
        }
        for (const release of artistResults.artist.releases[type].items) {
            await createDownloadJob(release, setStatusBar, ffmpegState, settings, toast, undefined, undefined, country);
        }
    }
    toast({
        title: `Added all ${artistReleaseCategories.find((category) => category.value === type)?.label ?? 'releases'} by '${artistResults.artist.name.display}'`,
        description: 'All releases have been added to the queue'
    });
}

export async function loadArtistResults(setArtistResults: React.Dispatch<React.SetStateAction<QobuzArtistResults | null>>): Promise<QobuzArtistResults | null> {
    return new Promise((resolve) => {
        setArtistResults((prev: QobuzArtistResults | null) => (resolve(prev), prev));
    });
}
