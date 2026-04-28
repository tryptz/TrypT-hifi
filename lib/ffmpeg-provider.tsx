'use client';
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { FFmpegType } from './ffmpeg-functions';

const FFmpegContext = createContext<
    | {
          ffmpegState: FFmpegType | null;
      }
    | undefined
>(undefined);

export const FFmpegProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [ffmpegState, setFfmpegState] = useState<FFmpegType | null>(null);

    useEffect(() => {
        setFfmpegState(new FFmpeg());
    }, []);

    return <FFmpegContext.Provider value={{ ffmpegState }}>{children}</FFmpegContext.Provider>;
};

export const useFFmpeg = () => {
    const context = useContext(FFmpegContext);

    if (!context) {
        throw new Error('useFFmpeg must be used within a FFmpegProvider');
    }

    return context;
};
