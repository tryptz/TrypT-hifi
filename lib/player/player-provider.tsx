'use client';

// Global audio engine + playlist. Owns a single HTMLAudioElement and plays tracks
// retained in the IndexedDB library (lib/library-store). Blobs are loaded on demand
// and their object URLs are revoked when the track changes — a managed lifecycle,
// unlike the download flow which revokes after 100ms.

import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { deleteLibraryTrack, getLibraryTrack, LibraryTrackMeta, listLibraryTracks, unplayableCodecs } from '@/lib/library-store';

export type RepeatMode = 'off' | 'all' | 'one';

/** Dispatched by the download retention hook after a track is saved. */
export const LIBRARY_CHANGED_EVENT = 'trypt:library-changed';

export function notifyLibraryChanged() {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT));
}

type PlayerContextValue = {
    library: LibraryTrackMeta[];
    queue: LibraryTrackMeta[];
    current: LibraryTrackMeta | null;
    currentIndex: number;
    isPlaying: boolean;
    loading: boolean;
    position: number;
    duration: number;
    volume: number;
    muted: boolean;
    shuffle: boolean;
    repeat: RepeatMode;
    error: string | null;
    libraryLoading: boolean;

    playFromLibrary: (id: number) => void;
    playList: (tracks: LibraryTrackMeta[], startIndex?: number) => void;
    togglePlay: () => void;
    next: () => void;
    previous: () => void;
    seek: (seconds: number) => void;
    setVolume: (v: number) => void;
    toggleMute: () => void;
    toggleShuffle: () => void;
    cycleRepeat: () => void;
    stop: () => void;
    isCurrent: (id: number) => boolean;
    refreshLibrary: () => Promise<void>;
    removeFromLibrary: (id: number) => Promise<void>;
};

const PlayerContext = createContext<PlayerContextValue | undefined>(undefined);

function buildShuffleOrder(length: number, start: number): number[] {
    const indices = Array.from({ length }, (_, i) => i).filter((i) => i !== start);
    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor((i + 1) * pseudoRandom(i + length + start));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return start >= 0 ? [start, ...indices] : indices;
}

// Deterministic-enough jitter (Math.random is unavailable in some sandboxes; this
// only needs to feel shuffled, not be cryptographically random).
function pseudoRandom(seed: number): number {
    const x = Math.sin(seed * 99991 + 12345) * 43758.5453;
    return x - Math.floor(x);
}

export const PlayerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [library, setLibrary] = useState<LibraryTrackMeta[]>([]);
    const [libraryLoading, setLibraryLoading] = useState(true);
    const [queue, setQueue] = useState<LibraryTrackMeta[]>([]);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [loading, setLoading] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolumeState] = useState(1);
    const [muted, setMuted] = useState(false);
    const [shuffle, setShuffle] = useState(false);
    const [repeat, setRepeat] = useState<RepeatMode>('off');
    const [error, setError] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const objectUrlRef = useRef<string | null>(null);
    const shuffleOrderRef = useRef<number[]>([]);
    // Refs mirroring state for use inside audio event handlers (avoid stale closures).
    const queueRef = useRef(queue);
    const indexRef = useRef(currentIndex);
    const repeatRef = useRef(repeat);
    const shuffleRef = useRef(shuffle);
    queueRef.current = queue;
    indexRef.current = currentIndex;
    repeatRef.current = repeat;
    shuffleRef.current = shuffle;

    const refreshLibrary = useCallback(async () => {
        try {
            const tracks = await listLibraryTracks();
            setLibrary(tracks);
        } catch {
            setLibrary([]);
        } finally {
            setLibraryLoading(false);
        }
    }, []);

    // Load an index in the current queue and start playback.
    const loadIndex = useCallback(async (index: number, autoplay = true) => {
        const audio = audioRef.current;
        const list = queueRef.current;
        if (!audio || index < 0 || index >= list.length) return;
        const meta = list[index];
        setCurrentIndex(index);
        setError(null);

        if (unplayableCodecs.has(meta.codec)) {
            setError(`${meta.codec} files can't be played in the browser. Choose FLAC/MP3/AAC to play in-app.`);
            setIsPlaying(false);
            return;
        }

        setLoading(true);
        try {
            const full = await getLibraryTrack(meta.id);
            if (!full) {
                if (objectUrlRef.current) {
                    URL.revokeObjectURL(objectUrlRef.current);
                    objectUrlRef.current = null;
                }
                setError('This track is no longer in the library.');
                setLoading(false);
                return;
            }
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            const url = URL.createObjectURL(full.blob);
            objectUrlRef.current = url;
            audio.src = url;
            setPosition(0);
            setDuration(meta.duration || 0);
            if (autoplay) {
                await audio.play().catch(() => setIsPlaying(false));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load track');
        } finally {
            setLoading(false);
        }
    }, []);

    const next = useCallback(() => {
        const list = queueRef.current;
        if (list.length === 0) return;
        const idx = indexRef.current;
        if (shuffleRef.current) {
            const order = shuffleOrderRef.current;
            const pos = order.indexOf(idx);
            if (pos === -1) {
                // Current track isn't in the shuffle order (e.g. order went stale) —
                // restart the shuffled sequence.
                if (order.length > 0) void loadIndex(order[0]);
                return;
            }
            const nextPos = pos + 1;
            if (nextPos < order.length) void loadIndex(order[nextPos]);
            else if (repeatRef.current !== 'off') void loadIndex(order[0]);
        } else {
            const nextIdx = idx + 1;
            if (nextIdx < list.length) void loadIndex(nextIdx);
            else if (repeatRef.current !== 'off') void loadIndex(0);
        }
    }, [loadIndex]);

    const previous = useCallback(() => {
        const audio = audioRef.current;
        // Standard behaviour: restart current track if >3s in, else go to previous.
        if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
            return;
        }
        const list = queueRef.current;
        if (list.length === 0) return;
        const idx = indexRef.current;
        if (shuffleRef.current) {
            const order = shuffleOrderRef.current;
            const pos = order.indexOf(idx);
            if (pos === -1) {
                if (order.length > 0) void loadIndex(order[0]);
                return;
            }
            if (pos > 0) void loadIndex(order[pos - 1]);
            else if (repeatRef.current !== 'off') void loadIndex(order[order.length - 1]);
        } else {
            if (idx > 0) void loadIndex(idx - 1);
            else if (repeatRef.current !== 'off') void loadIndex(list.length - 1);
        }
    }, [loadIndex]);

    // Initialise the audio element once.
    useEffect(() => {
        const audio = new Audio();
        audio.preload = 'metadata';
        audioRef.current = audio;

        const onTime = () => setPosition(audio.currentTime);
        const onMeta = () => {
            if (!Number.isNaN(audio.duration) && Number.isFinite(audio.duration)) setDuration(audio.duration);
        };
        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onEnded = () => {
            if (repeatRef.current === 'one') {
                audio.currentTime = 0;
                void audio.play();
                return;
            }
            next();
        };
        const onError = () => {
            setError('Playback failed — the file may be in a format the browser cannot decode.');
            setIsPlaying(false);
        };

        audio.addEventListener('timeupdate', onTime);
        audio.addEventListener('loadedmetadata', onMeta);
        audio.addEventListener('durationchange', onMeta);
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);

        void refreshLibrary();
        const onLibChange = () => void refreshLibrary();
        window.addEventListener(LIBRARY_CHANGED_EVENT, onLibChange);

        return () => {
            audio.removeEventListener('timeupdate', onTime);
            audio.removeEventListener('loadedmetadata', onMeta);
            audio.removeEventListener('durationchange', onMeta);
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
            window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibChange);
            audio.pause();
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const regenShuffle = useCallback((len: number, start: number) => {
        shuffleOrderRef.current = buildShuffleOrder(len, start);
    }, []);

    const playList = useCallback(
        (tracks: LibraryTrackMeta[], startIndex = 0) => {
            if (tracks.length === 0 || startIndex < 0 || startIndex >= tracks.length) return;
            queueRef.current = tracks;
            setQueue(tracks);
            if (shuffleRef.current) regenShuffle(tracks.length, startIndex);
            void loadIndex(startIndex);
        },
        [loadIndex, regenShuffle]
    );

    const playFromLibrary = useCallback(
        (id: number) => {
            const idx = library.findIndex((t) => t.id === id);
            if (idx === -1) return;
            playList(library, idx);
        },
        [library, playList]
    );

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (currentIndex === -1) {
            if (library.length > 0) playList(library, 0);
            return;
        }
        if (audio.paused) void audio.play().catch(() => setIsPlaying(false));
        else audio.pause();
    }, [currentIndex, library, playList]);

    const seek = useCallback((seconds: number) => {
        const audio = audioRef.current;
        if (audio) {
            audio.currentTime = seconds;
            setPosition(seconds);
        }
    }, []);

    const setVolume = useCallback((v: number) => {
        const clamped = Math.min(1, Math.max(0, v));
        setVolumeState(clamped);
        if (audioRef.current) audioRef.current.volume = clamped;
        if (clamped > 0 && audioRef.current?.muted) {
            audioRef.current.muted = false;
            setMuted(false);
        }
    }, []);

    const toggleMute = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.muted = !audio.muted;
        setMuted(audio.muted);
    }, []);

    const toggleShuffle = useCallback(() => {
        setShuffle((prev) => {
            const nextVal = !prev;
            if (nextVal) regenShuffle(queueRef.current.length, indexRef.current);
            return nextVal;
        });
    }, [regenShuffle]);

    const cycleRepeat = useCallback(() => {
        setRepeat((prev) => (prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'));
    }, []);

    const stop = useCallback(() => {
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
        }
        setIsPlaying(false);
    }, []);

    const removeFromLibrary = useCallback(
        async (id: number) => {
            const currentId = queueRef.current[indexRef.current]?.id;
            const wasCurrent = currentId === id;
            await deleteLibraryTrack(id);

            const updated = queueRef.current.filter((t) => t.id !== id);
            queueRef.current = updated;
            if (wasCurrent) {
                stop();
                indexRef.current = -1;
                setCurrentIndex(-1);
            } else if (currentId !== undefined) {
                // Keep pointing at the same track even though indices shifted.
                const newIdx = updated.findIndex((t) => t.id === currentId);
                indexRef.current = newIdx;
                setCurrentIndex(newIdx);
            }
            // Indices changed, so any cached shuffle order is stale.
            if (shuffleRef.current && updated.length > 0) {
                const start = indexRef.current >= 0 && indexRef.current < updated.length ? indexRef.current : 0;
                regenShuffle(updated.length, start);
            }
            setQueue(updated);

            await refreshLibrary();
            notifyLibraryChanged();
        },
        [refreshLibrary, stop, regenShuffle]
    );

    const isCurrent = useCallback((id: number) => queue[currentIndex]?.id === id, [queue, currentIndex]);

    const value = useMemo<PlayerContextValue>(
        () => ({
            library,
            queue,
            current: currentIndex >= 0 ? queue[currentIndex] ?? null : null,
            currentIndex,
            isPlaying,
            loading,
            position,
            duration,
            volume,
            muted,
            shuffle,
            repeat,
            error,
            libraryLoading,
            playFromLibrary,
            playList,
            togglePlay,
            next,
            previous,
            seek,
            setVolume,
            toggleMute,
            toggleShuffle,
            cycleRepeat,
            stop,
            isCurrent,
            refreshLibrary,
            removeFromLibrary
        }),
        [
            library,
            queue,
            currentIndex,
            isPlaying,
            loading,
            position,
            duration,
            volume,
            muted,
            shuffle,
            repeat,
            error,
            libraryLoading,
            playFromLibrary,
            playList,
            togglePlay,
            next,
            previous,
            seek,
            setVolume,
            toggleMute,
            toggleShuffle,
            cycleRepeat,
            stop,
            isCurrent,
            refreshLibrary,
            removeFromLibrary
        ]
    );

    return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
};

export const usePlayer = () => {
    const ctx = useContext(PlayerContext);
    if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider');
    return ctx;
};
