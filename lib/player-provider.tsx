'use client';
import axios from 'axios';
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { formatArtists, formatTitle, getAlbum, QobuzAlbum, QobuzTrack } from './qobuz-dl';
import { useCountry } from './country-provider';
import { isDeezerItem } from './deezer';
import { isTidalItem } from './tidal';

// ---------------------------------------------------------------------------
// In-browser streaming for Qobuz search results. A single <audio> element lives
// in this provider; cards and tracklists hand it a queue of tracks. Each track's
// URL is resolved lazily through /api/download-music, which returns a signed
// /api/file proxy link that supports Range requests, so the browser can seek
// and buffer progressively instead of downloading the whole file first.
// ---------------------------------------------------------------------------

// Quality ids understood by /api/download-music. CD-quality FLAC plays natively
// in every modern browser and is a fraction of the size of hi-res; MP3 320 is
// the fallback for browsers that refuse FLAC.
// Deezer tracks resolve through /api/deezer/preview instead, which returns the
// same signed-link shape for the track's 30-second MP3 preview. TIDAL tracks use
// /api/tidal/download-music, which takes the same quality ids (MP3 320 maps to
// TIDAL's AAC 320 there, which every browser can decode).
const STREAM_QUALITY = '6';
const FALLBACK_QUALITY = '5';

type PlayerContextValue = {
    queue: QobuzTrack[];
    index: number;
    current: QobuzTrack | null;
    playing: boolean;
    loading: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    playTracks: (tracks: QobuzTrack[], startIndex?: number) => void;
    playAlbum: (album: QobuzAlbum, startIndex?: number) => Promise<void>;
    togglePlay: () => void;
    next: () => void;
    previous: () => void;
    seek: (seconds: number) => void;
    setVolume: (volume: number) => void;
    stop: () => void;
};

const PlayerContext = createContext<PlayerContextValue | undefined>(undefined);

export const PlayerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { country } = useCountry();
    const audioRef = useRef<HTMLAudioElement | null>(null);
    // Incremented on every track change so a slow URL lookup for an old track can't hijack playback.
    const loadToken = useRef(0);
    const usedFallback = useRef(false);

    const [queue, setQueue] = useState<QobuzTrack[]>([]);
    const [index, setIndex] = useState(-1);
    const [playing, setPlaying] = useState(false);
    const [loading, setLoading] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolumeState] = useState(1);

    const current = index >= 0 && index < queue.length ? queue[index] : null;

    useEffect(() => {
        const saved = parseFloat(localStorage.getItem('playerVolume') ?? '');
        if (!isNaN(saved)) setVolumeState(Math.min(1, Math.max(0, saved)));
    }, []);

    useEffect(() => {
        if (audioRef.current) audioRef.current.volume = volume;
        localStorage.setItem('playerVolume', String(volume));
    }, [volume]);

    const next = useCallback(() => {
        setIndex((i) => (i + 1 < queue.length ? i + 1 : i));
    }, [queue.length]);

    const loadTrack = useCallback(
        async (track: QobuzTrack, quality: string, skip: () => void) => {
            const audio = audioRef.current;
            if (!audio) return;
            const token = ++loadToken.current;
            setLoading(true);
            setCurrentTime(0);
            setDuration(track.duration || 0);
            try {
                const response = isDeezerItem(track)
                    ? await axios.get('/api/deezer/preview', { params: { track_id: track.id } })
                    : await axios.get(isTidalItem(track) ? '/api/tidal/download-music' : '/api/download-music', {
                          params: { track_id: track.id, quality },
                          headers: country ? { 'Token-Country': country } : {}
                      });
                if (token !== loadToken.current) return;
                audio.src = response.data.data.url;
                await audio.play();
            } catch (error) {
                if (token !== loadToken.current) return;
                // Stale/nonexistent Deezer ids 404 here — skip to the next track instead of
                // stranding the queue on a dead entry. Axios surfaces the status on the error.
                const status = (error as any)?.response?.status;
                if (status === 404) {
                    console.warn('Skipping unavailable track', (error as any)?.config?.params?.track_id);
                    setPlaying(false);
                    setLoading(false);
                    skip();
                    return;
                }
                // play() rejects with NotAllowedError when autoplay is blocked; leave the track loaded and paused.
                if ((error as DOMException)?.name !== 'NotAllowedError') console.error('Failed to stream track', error);
                setPlaying(false);
                setLoading(false);
            }
        },
        [country]
    );

    // Whenever the current track changes, fetch its stream URL and start playing.
    useEffect(() => {
        if (!current) return;
        usedFallback.current = false;
        loadTrack(current, STREAM_QUALITY, next);
    }, [current?.id, index, queue]);

    const playTracks = useCallback((tracks: QobuzTrack[], startIndex = 0) => {
        const playable = tracks.filter((track) => track.streamable !== false);
        if (playable.length === 0) return;
        const start = tracks[startIndex];
        const playableIndex = Math.max(0, playable.indexOf(start));
        setQueue(playable);
        setIndex(playableIndex);
    }, []);

    const playAlbum = useCallback(
        async (album: QobuzAlbum, startIndex = 0) => {
            const albumRoute = isDeezerItem(album) ? '/api/deezer/get-album' : isTidalItem(album) ? '/api/tidal/get-album' : '/api/get-album';
            const response = await axios.get(albumRoute, { params: { album_id: album.id }, headers: country ? { 'Token-Country': country } : {} });
            const tracks: QobuzTrack[] = response.data.data.tracks.items.map((track: QobuzTrack) => ({ ...track, album }));
            playTracks(tracks, startIndex);
        },
        [country, playTracks]
    );

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio || !current) return;
        if (audio.paused) audio.play().catch(() => setPlaying(false));
        else audio.pause();
    }, [current]);

    const previous = useCallback(() => {
        const audio = audioRef.current;
        // Like most players: restart the song if we're more than a few seconds in, otherwise go back.
        if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
            return;
        }
        setIndex((i) => (i > 0 ? i - 1 : i));
    }, []);

    const seek = useCallback((seconds: number) => {
        if (audioRef.current) audioRef.current.currentTime = seconds;
        setCurrentTime(seconds);
    }, []);

    const setVolume = useCallback((value: number) => setVolumeState(Math.min(1, Math.max(0, value))), []);

    const stop = useCallback(() => {
        loadToken.current++;
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        }
        setQueue([]);
        setIndex(-1);
        setPlaying(false);
        setLoading(false);
        setCurrentTime(0);
        setDuration(0);
    }, []);

    const onEnded = () => {
        if (index + 1 < queue.length) setIndex(index + 1);
        else setPlaying(false);
    };

    const onError = () => {
        // A browser that can't decode FLAC gets one retry at MP3 320 before we give up on the track.
        // Deezer previews are already MP3, so there is nothing to fall back to.
        if (!current || !audioRef.current?.getAttribute('src')) return;
        if (!usedFallback.current && !isDeezerItem(current)) {
            usedFallback.current = true;
            loadTrack(current, FALLBACK_QUALITY, next);
            return;
        }
        setLoading(false);
        setPlaying(false);
    };

    // Media Session API: lock-screen / hardware media key controls and OS "now playing" metadata.
    useEffect(() => {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
        if (!current) {
            navigator.mediaSession.metadata = null;
            return;
        }
        const album = getAlbum(current);
        navigator.mediaSession.metadata = new MediaMetadata({
            title: formatTitle(current),
            artist: formatArtists(current),
            album: album?.title ?? '',
            artwork: album?.image ? [{ src: album.image.large || album.image.small, sizes: '600x600', type: 'image/jpeg' }] : []
        });
        navigator.mediaSession.setActionHandler('play', togglePlay);
        navigator.mediaSession.setActionHandler('pause', togglePlay);
        navigator.mediaSession.setActionHandler('nexttrack', next);
        navigator.mediaSession.setActionHandler('previoustrack', previous);
    }, [current, togglePlay, next, previous]);

    return (
        <PlayerContext.Provider
            value={{
                queue,
                index,
                current,
                playing,
                loading,
                currentTime,
                duration,
                volume,
                playTracks,
                playAlbum,
                togglePlay,
                next,
                previous,
                seek,
                setVolume,
                stop
            }}
        >
            {children}
            <audio
                ref={audioRef}
                preload='auto'
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onPlaying={() => setLoading(false)}
                onWaiting={() => setLoading(true)}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => {
                    if (isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
                }}
                onEnded={onEnded}
                onError={onError}
            />
        </PlayerContext.Provider>
    );
};

export const usePlayer = () => {
    const context = useContext(PlayerContext);

    if (!context) {
        throw new Error('usePlayer must be used within a PlayerProvider');
    }

    return context;
};
