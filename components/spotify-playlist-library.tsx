'use client';

import Image from 'next/image';
import React from 'react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { HeartIcon, ListMusicIcon, Loader2Icon } from 'lucide-react';
import { LIKED_SONGS_ID, SpotifyPlaylistSummary } from '@/lib/spotify';

// The signed-in user's playlists, browsable inside the import dialog. Picking
// one hands its id back so it can be matched and downloaded.
const SpotifyPlaylistLibrary = ({
    items,
    hasMore,
    loading,
    error,
    onSelect,
    onLoadMore
}: {
    items: SpotifyPlaylistSummary[];
    hasMore: boolean;
    loading: boolean;
    error: string;
    onSelect: (playlist: SpotifyPlaylistSummary) => void;
    onLoadMore: () => void;
}) => {
    if (error) return <p className='text-destructive text-sm font-semibold'>{error}</p>;

    if (loading && items.length === 0)
        return (
            <div className='flex items-center justify-center gap-2 py-8 text-muted-foreground'>
                <Loader2Icon className='size-4 animate-spin' />
                <span className='text-sm'>Loading your playlists…</span>
            </div>
        );

    if (items.length === 0) return <p className='text-sm text-muted-foreground py-8 text-center'>No playlists on this Spotify account yet.</p>;

    return (
        <ScrollArea className='max-h-[45vh]'>
            <div className='flex flex-col overflow-hidden pr-3'>
                {items.map((playlist, index) => (
                    <div key={playlist.id}>
                        <button
                            type='button'
                            onClick={() => onSelect(playlist)}
                            className='w-full flex items-center gap-3 overflow-hidden hover:bg-primary/5 transition-all p-2 rounded text-left'
                        >
                            <div className='relative shrink-0 aspect-square w-10 h-10 rounded-sm overflow-hidden bg-secondary flex items-center justify-center'>
                                {playlist.image ? (
                                    <Image fill src={playlist.image} alt={playlist.name} sizes='40px' className='object-cover' />
                                ) : playlist.id === LIKED_SONGS_ID ? (
                                    <HeartIcon className='size-5 opacity-60' />
                                ) : (
                                    <ListMusicIcon className='size-5 opacity-60' />
                                )}
                            </div>
                            <div className='overflow-hidden'>
                                <p className='truncate font-medium text-sm'>{playlist.name}</p>
                                <p className='truncate text-xs text-muted-foreground'>
                                    {playlist.total} {playlist.total === 1 ? 'track' : 'tracks'}
                                    {playlist.owner && ` · ${playlist.owner}`}
                                </p>
                            </div>
                        </button>
                        {index < items.length - 1 && <Separator />}
                    </div>
                ))}
                {hasMore && (
                    <Button variant='ghost' className='mt-2 w-full' disabled={loading} onClick={onLoadMore}>
                        {loading ? <Loader2Icon className='animate-spin' /> : 'Load more'}
                    </Button>
                )}
            </div>
        </ScrollArea>
    );
};

export default SpotifyPlaylistLibrary;
