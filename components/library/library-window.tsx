'use client';

import React from 'react';
import { DownloadIcon, HistoryIcon, ListMusicIcon, Trash2Icon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ScrollArea } from '../ui/scroll-area';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { TooltipProvider } from '../ui/tooltip';
import { useDownloads } from '@/lib/downloads/downloads-provider';
import { usePlayer } from '@/lib/player/player-provider';
import JobRow from './job-row';
import SavedTab from './saved-tab';

const isFinished = (s: string) => s === 'done' || s === 'error' || s === 'cancelled';

const EmptyState = ({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) => (
    <div className='flex h-56 flex-col items-center justify-center gap-2 text-center text-muted-foreground'>
        <div className='opacity-60'>{icon}</div>
        <p className='text-sm font-medium'>{title}</p>
        {hint && <p className='max-w-xs text-xs'>{hint}</p>}
    </div>
);

const LibraryWindow = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    const { jobs, clearFinished } = useDownloads();
    const { library } = usePlayer();

    const active = jobs.filter((j) => !isFinished(j.status));
    const history = jobs.filter((j) => isFinished(j.status)).slice().reverse();

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className='max-w-2xl gap-4'>
                <TooltipProvider delayDuration={300}>
                    <DialogHeader>
                        <DialogTitle className='flex items-center gap-2'>
                            <ListMusicIcon className='size-5' />
                            Library
                        </DialogTitle>
                        <DialogDescription>Manage your download queue and play tracks you&apos;ve saved.</DialogDescription>
                    </DialogHeader>

                    <Tabs defaultValue={active.length > 0 ? 'queue' : 'saved'} className='w-full'>
                        <TabsList className='grid w-full grid-cols-3'>
                            <TabsTrigger value='queue'>
                                <DownloadIcon />
                                Queue
                                {active.length > 0 && <Badge variant='secondary' className='ml-0.5 px-1.5'>{active.length}</Badge>}
                            </TabsTrigger>
                            <TabsTrigger value='history'>
                                <HistoryIcon />
                                History
                            </TabsTrigger>
                            <TabsTrigger value='saved'>
                                <ListMusicIcon />
                                Saved
                                {library.length > 0 && <Badge variant='secondary' className='ml-0.5 px-1.5'>{library.length}</Badge>}
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value='queue'>
                            {active.length === 0 ? (
                                <EmptyState icon={<DownloadIcon className='size-8' />} title='No active downloads' hint='Tracks and albums you download will appear here while they process.' />
                            ) : (
                                <ScrollArea className='h-[min(60vh,28rem)] pr-3'>
                                    <ul className='flex flex-col gap-1.5'>
                                        {active.map((job) => (
                                            <JobRow key={job.id} job={job} />
                                        ))}
                                    </ul>
                                </ScrollArea>
                            )}
                        </TabsContent>

                        <TabsContent value='history'>
                            {history.length === 0 ? (
                                <EmptyState icon={<HistoryIcon className='size-8' />} title='No download history yet' />
                            ) : (
                                <div className='flex flex-col gap-2'>
                                    <div className='flex justify-end'>
                                        <Button type='button' variant='ghost' size='sm' className='h-7 gap-1.5 px-2 text-muted-foreground' onClick={clearFinished}>
                                            <Trash2Icon className='size-3.5' />
                                            Clear finished
                                        </Button>
                                    </div>
                                    <ScrollArea className='h-[min(56vh,26rem)] pr-3'>
                                        <ul className='flex flex-col gap-1.5'>
                                            {history.map((job) => (
                                                <JobRow key={job.id} job={job} />
                                            ))}
                                        </ul>
                                    </ScrollArea>
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value='saved'>
                            <SavedTab />
                        </TabsContent>
                    </Tabs>
                </TooltipProvider>
            </DialogContent>
        </Dialog>
    );
};

export default LibraryWindow;
