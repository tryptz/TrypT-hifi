'use client';
import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';

export type MusicSource = 'qobuz' | 'apple' | 'deezer' | 'tidal';

export const MUSIC_SOURCES: MusicSource[] = ['qobuz', 'apple', 'deezer', 'tidal'];

export const sourceLabels: Record<MusicSource, string> = { qobuz: 'Qobuz', apple: 'Apple Music', deezer: 'Deezer', tidal: 'TIDAL' };

// Base path for the API routes of a given source. Qobuz lives at /api/*, Apple
// at /api/apple/*, Deezer at /api/deezer/* and TIDAL at /api/tidal/* (one-for-one mirrors). Every
// source-aware fetch composes this with the route name, e.g. `${sourceApiBase(source)}/get-music`.
export const sourceApiBase = (source: MusicSource): string => (source === 'qobuz' ? '/api' : `/api/${source}`);

// Apple, Deezer and TIDAL routes return artist/release data already normalized server-side;
// only raw Qobuz responses still need parseArtistData / parseArtistAlbumData on the client.
// The catalog an item actually came from, read from the item itself (each
// non-Qobuz normalizer attaches its own marker: `apple`, `deezer`, `tidal`;
// tracks may carry it on their album) rather than from the source toggle, so a
// list that outlives a source switch still labels every entry truthfully.
export const itemSource = (item: unknown): MusicSource => {
    const marked = (x: unknown): MusicSource | null => {
        const o = x as { apple?: unknown; deezer?: unknown; tidal?: unknown } | null | undefined;
        if (!o) return null;
        if (o.tidal) return 'tidal';
        if (o.deezer) return 'deezer';
        if (o.apple) return 'apple';
        return null;
    };
    return marked(item) ?? marked((item as { album?: unknown } | null)?.album) ?? 'qobuz';
};

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
