'use client';
import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';

export type MusicSource = 'qobuz' | 'apple' | 'deezer';

export const MUSIC_SOURCES: MusicSource[] = ['qobuz', 'apple', 'deezer'];

export const sourceLabels: Record<MusicSource, string> = { qobuz: 'Qobuz', apple: 'Apple Music', deezer: 'Deezer' };

// Base path for the API routes of a given source. Qobuz lives at /api/*, Apple
// at /api/apple/* and Deezer at /api/deezer/* (one-for-one mirrors). Every
// source-aware fetch composes this with the route name, e.g. `${sourceApiBase(source)}/get-music`.
export const sourceApiBase = (source: MusicSource): string => (source === 'qobuz' ? '/api' : `/api/${source}`);

// Apple and Deezer routes return artist/release data already normalized server-side;
// only raw Qobuz responses still need parseArtistData / parseArtistAlbumData on the client.
export const isPreParsedSource = (source: MusicSource): boolean => source !== 'qobuz';

const SourceContext = createContext<
    | {
          source: MusicSource;
          setSource: React.Dispatch<React.SetStateAction<MusicSource>>;
      }
    | undefined
>(undefined);

export const SourceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [source, setSource] = useState<MusicSource>('qobuz');

    useEffect(() => {
        const saved = localStorage.getItem('source');
        if (MUSIC_SOURCES.includes(saved as MusicSource)) setSource(saved as MusicSource);
    }, []);

    useEffect(() => {
        localStorage.setItem('source', source);
    }, [source]);

    return <SourceContext.Provider value={{ source, setSource }}>{children}</SourceContext.Provider>;
};

export const useSource = () => {
    const context = useContext(SourceContext);

    if (!context) {
        throw new Error('useSource must be used within a SourceProvider');
    }

    return context;
};
