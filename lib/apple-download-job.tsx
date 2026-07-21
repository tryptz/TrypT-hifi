import axios, { AxiosError } from 'axios';
import { createJob } from './status-bar/jobs';
import { Disc3Icon, DiscAlbumIcon } from 'lucide-react';
import { DownloadJobManifest } from './apple-music';
import { FetchedQobuzAlbum, formatTitle, QobuzAlbum, QobuzArtistResults, QobuzTrack } from './qobuz-dl';
import { SettingsProps } from './settings-provider';
import { StatusBarProps } from '@/components/status-bar/status-bar';
import { HandoffPayload } from './apple-handoff-provider';
import { artistReleaseCategories } from '@/components/artist-dialog';
import { loadArtistResults } from './download-job';

// ---------------------------------------------------------------------------
// Apple download path. Unlike the Qobuz path, trypt-hifi does NOT download or
// re-encode audio (Apple bytes are DRM-encrypted). It resolves a manifest per
// track and hands the batch to the native Tryptify app via a signed deep link
// + QR (and the REST pull queue), where FairPlay decryption and Dolby Atmos
// rendering happen on-device.
// ---------------------------------------------------------------------------

const adamIdOf = (item: QobuzTrack | QobuzAlbum): string => {
    const apple = (item as unknown as { apple?: { adamId?: string } }).apple;
    return apple?.adamId ?? String(item.id);
};

async function fetchManifest(adamId: string, quality: SettingsProps['appleQuality'], country?: string, signal?: AbortSignal): Promise<DownloadJobManifest> {
    const response = await axios.get('/api/apple/download-music', {
        params: { track_id: adamId, quality },
        headers: country ? { 'Token-Country': country } : {},
        signal
    });
    return response.data.data.manifest as DownloadJobManifest;
}

async function dispatchJob(manifests: DownloadJobManifest[], title: string, showHandoff: (payload: HandoffPayload) => void) {
    const response = await axios.post('/api/apple/job', { manifests });
    const { deepLink, fetchUrl, qrDataUrl, trackCount } = response.data.data;
    showHandoff({ title, deepLink, fetchUrl, qrDataUrl, trackCount });
}

export const createAppleDownloadJob = async (
    result: QobuzAlbum | QobuzTrack,
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    settings: SettingsProps,
    toast: (toast: any) => void,
    showHandoff: (payload: HandoffPayload) => void,
    country?: string,
    fetchedAlbumData?: FetchedQobuzAlbum | null,
    setFetchedAlbumData?: React.Dispatch<React.SetStateAction<FetchedQobuzAlbum | null>>
) => {
    const quality = settings.appleQuality;
    const isTrack = Boolean((result as QobuzTrack).album);
    const jobTitle = formatTitle(result);

    await createJob(setStatusBar, jobTitle, isTrack ? Disc3Icon : DiscAlbumIcon, async () => {
        return new Promise<void>(async (resolve) => {
            const controller = new AbortController();
            const signal = controller.signal;
            setStatusBar((prev) => ({
                ...prev,
                progress: 0,
                title: `Preparing ${jobTitle}`,
                description: 'Resolving Apple Music manifest...',
                onCancel: () => controller.abort()
            }));
            try {
                let manifests: DownloadJobManifest[];
                if (isTrack) {
                    manifests = [await fetchManifest(adamIdOf(result as QobuzTrack), quality, country, signal)];
                } else {
                    let album = fetchedAlbumData;
                    if (!album || album.id !== (result as QobuzAlbum).id) {
                        const albumResponse = await axios.get('/api/apple/get-album', {
                            params: { album_id: (result as QobuzAlbum).id },
                            headers: country ? { 'Token-Country': country } : {},
                            signal
                        });
                        album = albumResponse.data.data as FetchedQobuzAlbum;
                        setFetchedAlbumData?.(album);
                    }
                    const tracks = album!.tracks.items.filter((t) => t.streamable);
                    manifests = [];
                    for (let i = 0; i < tracks.length; i++) {
                        setStatusBar((prev) => ({ ...prev, progress: Math.floor((i / tracks.length) * 100), description: `Resolving ${i + 1}/${tracks.length}...` }));
                        manifests.push(await fetchManifest(adamIdOf(tracks[i]), quality, country, signal));
                    }
                }
                setStatusBar((prev) => ({ ...prev, progress: 100, description: 'Creating handoff...' }));
                await dispatchJob(manifests, jobTitle, showHandoff);
                resolve();
            } catch (e) {
                if (e instanceof AxiosError && e.code === 'ERR_CANCELED') return resolve();
                toast({ title: 'Error', description: e instanceof Error ? e.message : 'An unknown error occurred' });
                resolve();
            }
        });
    });
};

export async function downloadAppleArtistDiscography(
    artistResults: QobuzArtistResults,
    setArtistResults: React.Dispatch<React.SetStateAction<QobuzArtistResults | null>>,
    fetchMore: (searchField: any, artistResults: QobuzArtistResults) => Promise<void>,
    type: 'album' | 'epSingle' | 'live' | 'compilation' | 'all',
    setStatusBar: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    settings: SettingsProps,
    toast: (toast: any) => void,
    showHandoff: (payload: HandoffPayload) => void,
    country?: string
) {
    const types: ('album' | 'epSingle' | 'live' | 'compilation')[] = type === 'all' ? ['album', 'epSingle', 'live', 'compilation'] : [type];
    const albums: QobuzAlbum[] = [];
    for (const releaseType of types) {
        while (artistResults.artist.releases[releaseType].has_more) {
            await fetchMore(releaseType, artistResults);
            artistResults = (await loadArtistResults(setArtistResults)) as QobuzArtistResults;
        }
        albums.push(...artistResults.artist.releases[releaseType].items);
    }
    if (albums.length === 0) return;

    const jobTitle = `${artistResults.artist.name.display} discography`;
    await createJob(setStatusBar, jobTitle, DiscAlbumIcon, async () => {
        return new Promise<void>(async (resolve) => {
            const controller = new AbortController();
            const signal = controller.signal;
            setStatusBar((prev) => ({ ...prev, progress: 0, title: `Preparing ${jobTitle}`, description: 'Resolving manifests...', onCancel: () => controller.abort() }));
            try {
                const manifests: DownloadJobManifest[] = [];
                for (let i = 0; i < albums.length; i++) {
                    setStatusBar((prev) => ({ ...prev, progress: Math.floor((i / albums.length) * 100), description: `Album ${i + 1}/${albums.length}...` }));
                    const albumResponse = await axios.get('/api/apple/get-album', {
                        params: { album_id: albums[i].id },
                        headers: country ? { 'Token-Country': country } : {},
                        signal
                    });
                    const album = albumResponse.data.data as FetchedQobuzAlbum;
                    for (const track of album.tracks.items.filter((t) => t.streamable)) {
                        manifests.push(await fetchManifest(adamIdOf(track), settings.appleQuality, country, signal));
                    }
                }
                setStatusBar((prev) => ({ ...prev, progress: 100, description: 'Creating handoff...' }));
                await dispatchJob(manifests, jobTitle, showHandoff);
                resolve();
            } catch (e) {
                if (e instanceof AxiosError && e.code === 'ERR_CANCELED') return resolve();
                toast({ title: 'Error', description: e instanceof Error ? e.message : 'An unknown error occurred' });
                resolve();
            }
        });
    });
    toast({
        title: `Added ${artistReleaseCategories.find((c) => c.value === type)?.label ?? 'releases'} by '${artistResults.artist.name.display}'`,
        description: 'Resolving manifests for the Tryptify handoff'
    });
}
