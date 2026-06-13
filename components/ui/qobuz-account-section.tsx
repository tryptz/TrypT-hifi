'use client';

import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { KeyRoundIcon, Loader2Icon, LogInIcon, Trash2Icon } from 'lucide-react';
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

type Mode = 'login' | 'paste';

const errorMessage = (err: any, fallback: string): string => {
    const apiError = err?.response?.data?.error;
    if (typeof apiError === 'string') return apiError;
    if (Array.isArray(apiError)) return apiError.map((e: any) => e?.message || e).join(', ');
    return err?.message || fallback;
};

const QobuzAccountSection = ({ open }: { open: boolean }) => {
    const { toast } = useToast();

    const [mode, setMode] = useState<Mode>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
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

    const handleLogin = async () => {
        if (!email || !password) {
            toast({ title: 'Qobuz', description: 'Enter your email and password.', variant: 'destructive' });
            return;
        }
        setSubmitting(true);
        try {
            await axios.post('/api/qobuz-auth/login', { email, password });
            toast({ title: 'Qobuz', description: 'Logged in — token saved.' });
            setPassword('');
            await refreshTokens();
        } catch (err) {
            toast({ title: 'Qobuz', description: errorMessage(err, 'Login failed.'), variant: 'destructive' });
        } finally {
            setSubmitting(false);
        }
    };

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
            <div className='grid grid-cols-2 gap-2'>
                <Button
                    variant={mode === 'login' ? 'default' : 'outline'}
                    className='flex gap-2 items-center'
                    onClick={() => setMode('login')}
                    type='button'
                >
                    <LogInIcon className='size-4' />
                    Email &amp; Password
                </Button>
                <Button
                    variant={mode === 'paste' ? 'default' : 'outline'}
                    className='flex gap-2 items-center'
                    onClick={() => setMode('paste')}
                    type='button'
                >
                    <KeyRoundIcon className='size-4' />
                    Paste Token
                </Button>
            </div>

            {mode === 'login' ? (
                <div className='space-y-2'>
                    <Input
                        type='email'
                        autoComplete='username'
                        placeholder='Qobuz email'
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={submitting}
                    />
                    <Input
                        type='password'
                        autoComplete='current-password'
                        placeholder='Qobuz password'
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleLogin();
                        }}
                        disabled={submitting}
                    />
                    <Button className='w-full flex gap-2 items-center' onClick={handleLogin} disabled={submitting} type='button'>
                        {submitting && <Loader2Icon className='size-4 animate-spin' />}
                        Log in &amp; save
                    </Button>
                    <p className='text-xs text-muted-foreground'>
                        Your password is sent to this server only to fetch a Qobuz auth token. It is never stored — only the token is saved.
                    </p>
                </div>
            ) : (
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
                        Grab the value of <span className='font-mono'>localuser.token</span> from localStorage while logged in at play.qobuz.com.
                    </p>
                </div>
            )}

            <div className='space-y-2'>
                <div className='flex items-center justify-between'>
                    <p className='font-medium text-sm'>Saved tokens</p>
                    {loadingTokens && <Loader2Icon className='size-4 animate-spin text-muted-foreground' />}
                </div>
                {tokens.length === 0 ? (
                    <p className='text-xs text-muted-foreground'>{loadingTokens ? 'Loading…' : 'No tokens saved yet.'}</p>
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
