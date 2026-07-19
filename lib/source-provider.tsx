'use client';
import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';

export type MusicSource = 'qobuz' | 'apple';

// Base path for the API routes of a given source. Qobuz lives at /api/*, Apple
// at /api/apple/* (a one-for-one mirror). Every source-aware fetch composes this
// with the route name, e.g. `${sourceApiBase(source)}/get-music`.
export const sourceApiBase = (source: MusicSource): string => (source === 'apple' ? '/api/apple' : '/api');

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
        if (saved === 'apple' || saved === 'qobuz') setSource(saved);
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
