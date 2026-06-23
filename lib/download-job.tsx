import axios from 'axios';
import saveAs from 'file-saver';
import { applyMetadata, codecMap, FFmpegType, fixMD5Hash, loadFFmpeg } from './ffmpeg-functions';
import { artistReleaseCategories } from '@/components/artist-dialog';
import { cleanFileName, formatBytes, formatCustomTitle, resizeImage } from './utils';
import { FetchedQobuzAlbum, formatArtists, formatTitle, getFullResImageUrl, QobuzAlbum, QobuzArtistResults, QobuzTrack } from './qobuz-dl';
import { SettingsProps } from './settings-provider';
import { ToastAction } from '@/components/ui/toast';
import { zipSync } from 'fflate';
import { codecMimeMap, LibraryTrack, putLibraryTrack } from './library-store';
import { notifyLibraryChanged } from './player/player-provider';
import type { DownloadsApi, JobHandle } from './downloads/downloads-provider';

const requiresFFmpeg = (settings: SettingsProps) =>
    settings.applyMetadata || !((settings.outputQuality === '27' && settings.outputCodec === 'FLAC') || (settings.bitrate === 320 && settings.outputCodec === 'MP3'));

/** Persist a processed track into the in-app IndexedDB library for later playback. */
async function saveTrackToLibrary(track: QobuzTrack, data: ArrayBuffer | Uint8Array | Blob, settings: SettingsProps, source: 'single' | 'album') {
    const codec = settings.outputCodec;
    const mimeType = codecMimeMap[codec] ?? 'audio/flac';
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeType });
    const libTrack: LibraryTrack = {
        id: track.id,
        title: formatTitle(track),
        artist: formatArtists(track),
        album: track.album?.title ?? '',
        albumId: track.album?.id,
        artworkUrl: track.album?.image?.large ?? track.album?.image?.small ?? '',
        duration: track.duration,
        codec,
        mimeType,
        extension: codecMap[codec].extension,
        hires: track.hires,
        bitDepth: track.maximum_bit_depth,
        sampleRate: track.maximum_sampling_rate,
        trackNumber: track.track_number,
        source,
        size: blob.size,
        addedAt: Date.now(),
        blob
    };
    await putLibraryTrack(libTrack);
    notifyLibraryChanged();
}

export const createDownloadJob = async (
    result: QobuzAlbum | QobuzTrack,
    downloads: DownloadsApi,
    ffmpegState: FFmpegType,
    settings: SettingsProps,
    toast: (toast: any) => void,
    fetchedAlbumData?: FetchedQobuzAlbum | null,
    setFetchedAlbumData?: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>,
    country?: string
) => {
    if ((result as QobuzTrack).album) {
        const track = result as QobuzTrack;
        const formattedTitle = formatCustomTitle(settings.trackName, track);
        downloads.enqueue(
            { kind: 'track', title: formatTitle(track), subtitle: formatArtists(track), artworkUrl: track.album?.image?.small },
            async (handle: JobHandle) => {
                const stage = (s: string) => handle.update({ stage: s });
                if (requiresFFmpeg(settings)) {
                    stage('Loading FFmpeg…');
                    await loadFFmpeg(ffmpegState);
                }
                stage('Fetching track size…');
                const APIResponse = await axios.get('/api/download-music', {
                    headers: { 'Token-Country': country },
                    params: { track_id: track.id, quality: settings.outputQuality },
                    signal: handle.signal
                });
                const trackURL = APIResponse.data.data.url;
                const fileSizeResponse = await axios.head(trackURL, { signal: handle.signal });
                const fileSize = parseInt(fileSizeResponse.headers['content-length']);
                const response = await axios.get(trackURL, {
                    responseType: 'arraybuffer',
                    onDownloadProgress: (progressEvent) => {
                        if (handle.isCancelled()) return;
                        handle.update({
                            progress: Math.floor((progressEvent.loaded / fileSize) * 100),
                            bytesDone: progressEvent.loaded,
                            bytesTotal: fileSize,
                            stage: `${formatBytes(progressEvent.loaded)} / ${formatBytes(fileSize)}`
                        });
                    },
                    signal: handle.signal
                });
                handle.update({ status: 'processing', progress: 100, stage: 'Applying metadata…' });
                const inputFile = response.data;
                const outputFile = await applyMetadata(inputFile, track, ffmpegState, settings, stage);
                let finalData: ArrayBuffer | Uint8Array | Blob = outputFile;
                if (settings.outputCodec === 'FLAC' && settings.fixMD5) finalData = await fixMD5Hash(outputFile, stage, (pct) => handle.update({ progress: pct }));

                const blob = finalData instanceof Blob ? finalData : new Blob([finalData as BlobPart], { type: codecMimeMap[settings.outputCodec] ?? 'audio/flac' });
                const objectURL = URL.createObjectURL(blob);
                const filename = formattedTitle + '.' + codecMap[settings.outputCodec].extension;

                const finish = async () => {
                    saveAs(objectURL, filename);
                    setTimeout(() => URL.revokeObjectURL(objectURL), 100);
                    if (settings.saveToLibrary) {
                        try {
                            await saveTrackToLibrary(track, blob, settings, 'single');
                        } catch (e) {
                            toast({ title: 'Library', description: `Saved the file but couldn't add it to the library: ${e instanceof Error ? e.message : 'unknown error'}` });
                        }
                    }
                };

                // Validate duration: guards against Qobuz returning a 30s sample.
                await new Promise<void>((resolve) => {
                    let settled = false;
                    const finishOnce = () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timeout);
                        void finish().finally(() => resolve());
                    };
                    const audioElement = document.createElement('audio');
                    audioElement.id = `track_${track.id}`;
                    audioElement.src = objectURL;
                    // If metadata never loads (and no error fires), don't hang forever —
                    // the bytes are already fully downloaded, so just proceed. `timeout`
                    // is referenced by finishOnce above (a closure, so the forward ref is
                    // resolved only when it actually runs — after this assignment).
                    const timeout = setTimeout(finishOnce, 15000);
                    audioElement.onloadedmetadata = () => {
                        if (settled) return;
                        clearTimeout(timeout);
                        if (Math.round(audioElement.duration) >= Math.round(track.duration)) {
                            finishOnce();
                        } else {
                            settled = true;
                            toast({
                                title: 'Error',
                                description: `Qobuz provided a file shorter than expected for "${filename}". This can indicate the file being a sample track rather than the full track`,
                                duration: Infinity,
                                action: (
                                    <ToastAction altText='Download anyway' onClick={() => void finish()}>
                                        Download anyway
                                    </ToastAction>
                                )
                            });
                            resolve();
                        }
                    };
                    audioElement.onerror = () => finishOnce();
                    document.body.append(audioElement);
                });
            }
        );
    } else {
        const album = result as QobuzAlbum;
        const formattedZipTitle = formatCustomTitle(settings.zipName, album);
        downloads.enqueue(
            { kind: 'album', title: formatTitle(album), subtitle: formatArtists(album), artworkUrl: album.image?.small },
            async (handle: JobHandle) => {
                const stage = (s: string) => handle.update({ stage: s });
                if (requiresFFmpeg(settings)) {
                    stage('Loading FFmpeg…');
                    await loadFFmpeg(ffmpegState);
                }
                stage('Fetching album data…');
                if (!fetchedAlbumData) {
                    const albumDataResponse = await axios.get('/api/get-album', {
                        params: { album_id: album.id },
                        headers: { 'Token-Country': country },
                        signal: handle.signal
                    });
                    if (setFetchedAlbumData) setFetchedAlbumData(albumDataResponse.data.data);
                    fetchedAlbumData = albumDataResponse.data.data;
                }
                const albumTracks = fetchedAlbumData!.tracks.items.map((track: QobuzTrack) => ({ ...track, album: fetchedAlbumData })) as QobuzTrack[];
                let totalAlbumSize = 0;
                const albumUrls = [] as string[];
                stage('Fetching album size…');
                let currentDisk = 1;
                let trackOffset = 0;
                for (let index = 0; index < albumTracks.length; index++) {
                    if (handle.isCancelled()) break;
                    const track = albumTracks[index];
                    if (track.streamable) {
                        const fileURLResponse = await axios.get('/api/download-music', {
                            params: { track_id: track.id, quality: settings.outputQuality },
                            headers: { 'Token-Country': country },
                            signal: handle.signal
                        });
                        const trackURL = fileURLResponse.data.data.url;
                        if (!(currentDisk === track.media_number)) {
                            trackOffset = albumUrls.length;
                            currentDisk = track.media_number;
                            albumUrls.push(trackURL);
                        } else albumUrls[track.track_number + trackOffset - 1] = trackURL;
                        const fileSizeResponse = await axios.head(trackURL, { signal: handle.signal });
                        handle.update({ progress: (100 / albumTracks.length) * (index + 1) });
                        totalAlbumSize += parseInt(fileSizeResponse.headers['content-length']);
                    }
                }
                const trackBuffers = [] as (ArrayBuffer | Uint8Array)[];
                let totalBytesDownloaded = 0;
                handle.update({ progress: 0, stage: 'Fetching album art…' });
                const albumArtURL = await resizeImage(getFullResImageUrl(fetchedAlbumData!), settings.albumArtSize, settings.albumArtQuality);
                const albumArt = albumArtURL ? (await axios.get(albumArtURL, { responseType: 'arraybuffer' })).data : false;
                handle.update({ status: 'processing' });
                for (let index = 0; index < albumUrls.length; index++) {
                    if (handle.isCancelled()) break;
                    const url = albumUrls[index];
                    if (url) {
                        const response = await axios.get(url, {
                            responseType: 'arraybuffer',
                            onDownloadProgress: (progressEvent) => {
                                if (totalBytesDownloaded + progressEvent.loaded < totalAlbumSize && !handle.isCancelled())
                                    handle.update({
                                        progress: Math.floor(((totalBytesDownloaded + progressEvent.loaded) / totalAlbumSize) * 100),
                                        bytesDone: totalBytesDownloaded + progressEvent.loaded,
                                        bytesTotal: totalAlbumSize,
                                        stage: `${formatBytes(totalBytesDownloaded + progressEvent.loaded)} / ${formatBytes(totalAlbumSize)}`
                                    });
                            },
                            signal: handle.signal
                        });
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        totalBytesDownloaded += response.data.byteLength;
                        const inputFile = response.data;
                        let outputFile = await applyMetadata(inputFile, albumTracks[index], ffmpegState, settings, stage, albumArt, fetchedAlbumData!.upc);
                        if (settings.outputCodec === 'FLAC' && settings.fixMD5) outputFile = await (await fixMD5Hash(outputFile)).arrayBuffer();
                        trackBuffers[index] = outputFile;
                        // Retain each track individually so the whole album is playable in-app.
                        if (settings.saveToLibrary) {
                            try {
                                await saveTrackToLibrary(albumTracks[index], outputFile, settings, 'album');
                            } catch {
                                /* keep the download going even if one library write fails */
                            }
                        }
                    }
                }
                handle.update({ progress: 0, stage: 'Zipping album…' });
                await new Promise((resolve) => setTimeout(resolve, 500));
                const zipFiles = {
                    'cover.jpg': albumArt ? new Uint8Array(albumArt) : new Uint8Array(0),
                    ...trackBuffers.reduce(
                        (acc, buffer, index) => {
                            if (buffer) {
                                const fileName = `${(index + 1).toString().padStart(Math.max(String(albumTracks.length - 1).length, 2), '0')} ${formatCustomTitle(settings.trackName, albumTracks[index])}.${codecMap[settings.outputCodec].extension}`;
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
                handle.update({ progress: 100, stage: 'Saving…' });
                const objectURL = URL.createObjectURL(zipBlob);
                saveAs(objectURL, formattedZipTitle + '.zip');
                setTimeout(() => URL.revokeObjectURL(objectURL), 100);
            }
        );
    }
};

export async function downloadArtistDiscography(
    artistResults: QobuzArtistResults,
    setArtistResults: React.Dispatch<React.SetStateAction<QobuzArtistResults | null>>,
    fetchMore: (searchField: any, artistResults: QobuzArtistResults) => Promise<void>,
    type: 'album' | 'epSingle' | 'live' | 'compilation' | 'all',
    downloads: DownloadsApi,
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
            await createDownloadJob(release, downloads, ffmpegState, settings, toast, undefined, undefined, country);
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
