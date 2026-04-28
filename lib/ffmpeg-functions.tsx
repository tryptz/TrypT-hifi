import { formatArtists, formatTitle, getAlbum, getFullResImageUrl, QobuzTrack } from './qobuz-dl';
import axios from 'axios';
import { SettingsProps } from './settings-provider';
import { StatusBarProps } from '@/components/status-bar/status-bar';
import { resizeImage } from './utils';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

export type FFmpegType = FFmpeg;

export const codecMap = {
    FLAC: {
        extension: 'flac',
        codec: 'flac'
    },
    WAV: {
        extension: 'wav',
        codec: 'pcm_s16le'
    },
    ALAC: {
        extension: 'm4a',
        codec: 'alac'
    },
    MP3: {
        extension: 'mp3',
        codec: 'libmp3lame'
    },
    AAC: {
        extension: 'm4a',
        codec: 'aac'
    },
    OPUS: {
        extension: 'opus',
        codec: 'libopus'
    }
};

export async function applyMetadata(
    trackBuffer: ArrayBuffer | Uint8Array,
    resultData: QobuzTrack,
    ffmpeg: FFmpegType,
    settings: SettingsProps,
    setStatusBar?: React.Dispatch<React.SetStateAction<StatusBarProps>>,
    albumArt?: ArrayBuffer | false,
    upc?: string
) {
    const skipRencode =
        (settings.outputQuality != '5' && settings.outputCodec === 'FLAC') ||
        (settings.outputQuality === '5' && settings.outputCodec === 'MP3' && settings.bitrate === 320);
    if (skipRencode && !settings.applyMetadata) return trackBuffer;
    const extension = codecMap[settings.outputCodec].extension;
    if (!skipRencode) {
        const inputExtension = settings.outputQuality === '5' ? 'mp3' : 'flac';
        if (setStatusBar)
            setStatusBar((prev) => {
                if (prev.processing) {
                    return { ...prev, description: 'Re-encoding track...' };
                } else return prev;
            });
        await ffmpeg.writeFile('input.' + inputExtension, new Uint8Array(trackBuffer));
        await ffmpeg.exec([
            '-i',
            'input.' + inputExtension,
            '-c:a',
            codecMap[settings.outputCodec].codec,
            ...(settings.bitrate ? ['-b:a', settings.bitrate + 'k'] : []),
            ...(['OPUS'].includes(settings.outputCodec) ? ['-vbr', 'on'] : []),
            'output.' + extension
        ]);
        trackBuffer = (await ffmpeg.readFile('output.' + extension)) as Uint8Array;
        await ffmpeg.deleteFile('input.' + inputExtension);
        await ffmpeg.deleteFile('output.' + extension);
    }
    if (!settings.applyMetadata) return trackBuffer;
    if (settings.outputCodec === 'WAV') return trackBuffer;
    if (setStatusBar) setStatusBar((prev) => ({ ...prev, description: 'Applying metadata...' }));
    const artists = resultData.album.artists === undefined ? [resultData.performer] : resultData.album.artists;
    let metadata = `;FFMETADATA1`;
    metadata += `\ntitle=${formatTitle(resultData)}`;
    if (artists.length > 0) {
        metadata += `\nartist=${formatArtists(resultData)}`;
        metadata += `\nalbum_artist=${formatArtists(resultData)}`;
    } else {
        metadata += `\nartist=Various Artists`;
        metadata += `\nalbum_artist=Various Artists`;
    }
    metadata += `\nalbum_artist=${artists[0]?.name || resultData.performer?.name || 'Various Artists'}`;
    metadata += `\nalbum=${formatTitle(resultData.album)}`;
    metadata += `\ngenre=${resultData.album.genre.name}`;
    metadata += `\ndate=${resultData.album.release_date_original}`;
    metadata += `\nyear=${new Date(resultData.album.release_date_original).getFullYear()}`;
    metadata += `\nlabel=${getAlbum(resultData).label.name}`;
    metadata += `\ncopyright=${resultData.copyright}`;
    if (resultData.isrc) metadata += `\nisrc=${resultData.isrc}`;
    if (upc) metadata += `\nbarcode=${upc}`;
    if (resultData.track_number) metadata += `\ntrack=${resultData.track_number}`;
    await ffmpeg.writeFile('input.' + extension, new Uint8Array(trackBuffer));
    const encoder = new TextEncoder();
    await ffmpeg.writeFile('metadata.txt', encoder.encode(metadata));
    if (!(albumArt === false)) {
        if (!albumArt) {
            const albumArtURL = await resizeImage(getFullResImageUrl(resultData), settings.albumArtSize, settings.albumArtQuality);
            if (albumArtURL) {
                albumArt = (await axios.get(albumArtURL, { responseType: 'arraybuffer' })).data;
            } else albumArt = false;
        }
        if (albumArt)
            await ffmpeg.writeFile(
                'albumArt.jpg',
                new Uint8Array(
                    albumArt
                        ? albumArt
                        : (
                              await axios.get((await resizeImage(getFullResImageUrl(resultData), settings.albumArtSize, settings.albumArtQuality)) as string, {
                                  responseType: 'arraybuffer'
                              })
                          ).data
                )
            );
    }

    await ffmpeg.exec(['-i', 'input.' + extension, '-i', 'metadata.txt', '-map_metadata', '1', '-codec', 'copy', 'secondInput.' + extension]);
    if (['WAV', 'OPUS'].includes(settings.outputCodec) || albumArt === false) {
        const output = (await ffmpeg.readFile('secondInput.' + extension)) as Uint8Array;
        await ffmpeg.deleteFile('input.' + extension);
        await ffmpeg.deleteFile('metadata.txt');
        await ffmpeg.deleteFile('secondInput.' + extension);
        return output;
    }
    await ffmpeg.exec([
        '-i',
        'secondInput.' + extension,
        '-i',
        'albumArt.jpg',
        '-c',
        'copy',
        '-map',
        '0',
        '-map',
        '1',
        '-disposition:v:0',
        'attached_pic',
        'output.' + extension
    ]);
    const output = (await ffmpeg.readFile('output.' + extension)) as Uint8Array;
    await ffmpeg.deleteFile('input.' + extension);
    await ffmpeg.deleteFile('metadata.txt');
    await ffmpeg.deleteFile('secondInput.' + extension);
    await ffmpeg.deleteFile('albumArt.jpg');
    return output;
}

export async function fixMD5Hash(trackBuffer: ArrayBuffer | Uint8Array, setStatusBar?: React.Dispatch<React.SetStateAction<StatusBarProps>>): Promise<Blob> {
    return new Promise((resolve) => {
        setStatusBar?.((prev) => ({ ...prev, description: 'Fixing MD5 hash...', progress: 0 }));
        const worker = new Worker('flac/EmsWorkerProxy.js');
        worker.onmessage = function (e) {
            if (e.data && e.data.reply === 'progress') {
                const vals = e.data.values;
                if (vals[1]) {
                    setStatusBar?.((prev) => ({ ...prev, progress: Math.floor((vals[0] / vals[1]) * 100) }));
                }
            } else if (e.data && e.data.reply === 'done') {
                for (const fileName in e.data.values) {
                    resolve(e.data.values[fileName].blob);
                }
            }
        };
        worker.postMessage({
            command: 'encode',
            args: ['input.flac', '-o', 'output.flac'],
            outData: {
                'output.flac': {
                    MIME: 'audio/flac'
                }
            },
            fileData: {
                'input.flac': new Uint8Array(trackBuffer)
            }
        });
    });
}

export async function loadFFmpeg(ffmpeg: FFmpegType) {
    if (!ffmpeg.loaded) {
        const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
        await ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
    }
}
