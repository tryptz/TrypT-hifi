'use client';

import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2Icon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { useToast } from '@/hooks/use-toast';

type MaskedToken = {
    id: string;
    masked: string;
    label?: string;
    country?: string | null;
    addedAt: number;
};

const errorMessage = (err: any, fallback: string): string => {
    const apiError = err?.response?.data?.error;
    if (typeof apiError === 'string') return apiError;
    if (Array.isArray(apiError)) return apiError.map((e: any) => e?.message || e).join(', ');
    return err?.message || fallback;
};

const QobuzAccountSection = ({ open }: { open: boolean }) => {
    const { toast } = useToast();

    const [pastedToken, setPastedToken] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const [tokens, setTokens] = useState<MaskedToken[]>([]);
    const [loadingTokens, setLoadingTokens] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const refreshTokens = useCallback(async () => {
        setLoadingTokens(true);
        try {
            const res = await axios.get('/api/qobuz-auth');
            setTokens(res.data?.data ?? []);
        } catch (err) {
            toast({ title: 'Qobuz', description: errorMessage(err, 'Could not load saved tokens.'), variant: 'destructive' });
        } finally {
            setLoadingTokens(false);
        }
    }, [toast]);

    // Re-fetch the token list whenever the settings sheet is opened.
    useEffect(() => {
        if (open) refreshTokens();
    }, [open, refreshTokens]);

    const handlePaste = async () => {
        if (!pastedToken.trim()) {
            toast({ title: 'Qobuz', description: 'Paste a token first.', variant: 'destructive' });
            return;
        }
        setSubmitting(true);
        try {
            await axios.post('/api/qobuz-auth', { token: pastedToken.trim() });
            toast({ title: 'Qobuz', description: 'Token validated and saved.' });
            setPastedToken('');
            await refreshTokens();
        } catch (err) {
            toast({ title: 'Qobuz', description: errorMessage(err, 'Could not save token.'), variant: 'destructive' });
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id: string) => {
        setDeletingId(id);
        try {
            await axios.delete('/api/qobuz-auth', { data: { id } });
            setTokens((prev) => prev.filter((t) => t.id !== id));
        } catch (err) {
            toast({ title: 'Qobuz', description: errorMessage(err, 'Could not remove token.'), variant: 'destructive' });
        } finally {
            setDeletingId(null);
        }
    };

    return (
        <div className='space-y-3'>
            <div className='space-y-2'>
                <Input
                    type='password'
                    placeholder='user_auth_token'
                    value={pastedToken}
                    onChange={(e) => setPastedToken(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handlePaste();
                    }}
                    disabled={submitting}
                />
                <Button className='w-full flex gap-2 items-center' onClick={handlePaste} disabled={submitting} type='button'>
                    {submitting && <Loader2Icon className='size-4 animate-spin' />}
                    Validate &amp; save
                </Button>
                <p className='text-xs text-muted-foreground'>
                    Paste a <span className='font-mono'>user_auth_token</span> from{' '}
                    <span className='font-mono'>play.qobuz.com</span> (localStorage key <span className='font-mono'>localuser.token</span>).
                </p>
            </div>

            <div className='space-y-2'>
                <div className='flex items-center justify-between gap-2'>
                    <p className='font-medium text-sm'>Saved tokens</p>
                    <Button variant='ghost' size='sm' className='h-8 px-2' onClick={refreshTokens} disabled={loadingTokens} type='button'>
                        {loadingTokens ? <Loader2Icon className='size-4 animate-spin' /> : <RefreshCwIcon className='size-4' />}
                        Refresh
                    </Button>
                </div>
                {tokens.length === 0 ? (
                    <p className='text-xs text-muted-foreground'>{loadingTokens ? 'Loading...' : 'No tokens saved yet.'}</p>
                ) : (
                    <div className='flex flex-col gap-1.5'>
                        {tokens.map((t) => (
                            <div key={t.id} className='flex items-center justify-between gap-2 rounded-md border border-input px-2.5 py-1.5'>
                                <div className='flex flex-col min-w-0'>
                                    <span className='text-sm truncate'>{t.label || 'token'}</span>
                                    <span className='text-xs text-muted-foreground font-mono truncate'>{t.masked}</span>
                                </div>
                                <Button
                                    size='icon'
                                    variant='destructive'
                                    className='aspect-square shrink-0'
                                    onClick={() => handleDelete(t.id)}
                                    disabled={deletingId === t.id}
                                    type='button'
                                    aria-label='Remove token'
                                >
                                    {deletingId === t.id ? <Loader2Icon className='size-4 animate-spin' /> : <Trash2Icon className='size-4' />}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default QobuzAccountSection;
