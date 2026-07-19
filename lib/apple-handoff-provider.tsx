'use client';
import React, { createContext, useContext, useState, ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CopyIcon, SmartphoneIcon } from 'lucide-react';

export type HandoffPayload = {
    title: string;
    deepLink: string;
    fetchUrl: string;
    qrDataUrl: string;
    trackCount: number;
};

const HandoffContext = createContext<{ showHandoff: (payload: HandoffPayload) => void } | undefined>(undefined);

export const AppleHandoffProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [payload, setPayload] = useState<HandoffPayload | null>(null);
    const [open, setOpen] = useState(false);

    const showHandoff = (next: HandoffPayload) => {
        setPayload(next);
        setOpen(true);
    };

    return (
        <HandoffContext.Provider value={{ showHandoff }}>
            {children}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className='max-w-[420px]'>
                    <DialogHeader>
                        <DialogTitle>Send to Tryptify</DialogTitle>
                        <DialogDescription>
                            {payload ? `“${payload.title}” — ${payload.trackCount} ${payload.trackCount === 1 ? 'track' : 'tracks'}` : ''}
                        </DialogDescription>
                    </DialogHeader>
                    {payload && (
                        <div className='flex flex-col items-center gap-4'>
                            <img src={payload.qrDataUrl} alt='Tryptify handoff QR code' className='w-[240px] h-[240px] rounded-md bg-white p-2' />
                            <p className='text-xs text-muted-foreground text-center'>
                                Scan with Tryptify, or open the link on this device. Tryptify decrypts and renders (incl. Dolby Atmos) on-device.
                            </p>
                            <div className='flex gap-2 w-full'>
                                <Button asChild className='flex-1 gap-2'>
                                    <a href={payload.deepLink}>
                                        <SmartphoneIcon className='!size-4' />
                                        Open in Tryptify
                                    </a>
                                </Button>
                                <Button
                                    variant='outline'
                                    size='icon'
                                    title='Copy handoff link'
                                    onClick={() => navigator.clipboard.writeText(payload.deepLink)}
                                >
                                    <CopyIcon className='!size-4' />
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </HandoffContext.Provider>
    );
};

export const useAppleHandoff = () => {
    const context = useContext(HandoffContext);
    if (!context) throw new Error('useAppleHandoff must be used within an AppleHandoffProvider');
    return context;
};
