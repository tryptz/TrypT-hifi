'use client';

import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { AlertTriangleIcon, CheckCircle2Icon, CopyIcon, ExternalLinkIcon, Loader2Icon } from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { useToast } from '@/hooks/use-toast';

type Health = { appCredentials: boolean; tokens: boolean; ready: boolean };

// Copy with a legacy fallback: navigator.clipboard is undefined on insecure
// (plain http) origins — which is exactly how this instance is often reached on
// a LAN — so fall back to a hidden textarea + execCommand('copy') there.
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the legacy path
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

// Settings panel that surfaces this server's role as a Qobuz "instance" for the
// Tryptify (monotrypt.android) Android app: it shows the URL to paste into the
// app, a live readiness indicator (pulled from GET /api), and what to fix when
// the instance isn't ready.
const InstanceModeSection = ({ open }: { open: boolean }) => {
    const { toast } = useToast();

    const [url, setUrl] = useState('');
    const [version, setVersion] = useState<string | null>(null);
    const [health, setHealth] = useState<Health | null>(null);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);

    // The URL the operator should hand to the phone is exactly the origin they
    // are viewing this app through (localhost, LAN IP, or the public tunnel).
    useEffect(() => {
        if (typeof window !== 'undefined') setUrl(window.location.origin);
    }, []);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = await axios.get('/api');
            const data = res.data?.data;
            setVersion(typeof data?.version === 'string' ? data.version : null);
            setHealth(data?.health ?? null);
        } catch {
            setHealth(null);
            setVersion(null);
        } finally {
            setLoading(false);
            setLoaded(true);
        }
    }, []);

    // Check instance health whenever the settings sheet is opened.
    useEffect(() => {
        if (open) refresh();
    }, [open, refresh]);

    const copy = async () => {
        const ok = await copyToClipboard(url);
        toast(
            ok
                ? { title: 'Instance Mode', description: 'Instance URL copied to clipboard.' }
                : { title: 'Instance Mode', description: 'Could not copy — select the URL and copy it manually.', variant: 'destructive' }
        );
    };

    const ready = health?.ready ?? false;

    return (
        <div className='space-y-3'>
            <div className='flex items-center gap-2' role='status' aria-live='polite'>
                {loading ? (
                    <Loader2Icon className='size-4 animate-spin text-muted-foreground shrink-0' aria-hidden='true' />
                ) : ready ? (
                    <CheckCircle2Icon className='size-4 text-green-500 shrink-0' aria-hidden='true' />
                ) : (
                    <AlertTriangleIcon className='size-4 text-yellow-500 shrink-0' aria-hidden='true' />
                )}
                <p className='text-sm'>
                    {loading || !loaded
                        ? 'Checking instance status…'
                        : ready
                          ? 'Ready — this server can serve the Tryptify app.'
                          : 'Not ready — finish the Qobuz setup below.'}
                </p>
            </div>

            <div className='space-y-1'>
                <p className='font-medium text-sm'>Qobuz instance URL</p>
                <div className='flex gap-2'>
                    <Input
                        readOnly
                        value={url}
                        className='font-mono text-xs'
                        onFocus={(e) => e.currentTarget.select()}
                        aria-label='Qobuz instance URL'
                    />
                    <Button
                        size='icon'
                        variant='outline'
                        className='aspect-square shrink-0'
                        onClick={copy}
                        type='button'
                        aria-label='Copy instance URL'
                    >
                        <CopyIcon className='size-4' />
                    </Button>
                </div>
            </div>

            {loaded && health && !ready && (
                <div className='text-xs space-y-0.5'>
                    {!health.appCredentials && <p className='text-destructive'>• Server is missing QOBUZ_APP_ID / QOBUZ_SECRET.</p>}
                    {health.appCredentials && !health.tokens && (
                        <p className='text-destructive'>• No Qobuz token yet — add one under &ldquo;Qobuz Account&rdquo; above.</p>
                    )}
                </div>
            )}

            <p className='text-xs text-muted-foreground'>
                Point the{' '}
                <a
                    href='https://github.com/tryptz/monotrypt.android'
                    target='_blank'
                    rel='noreferrer'
                    className='underline inline-flex items-center gap-0.5'
                >
                    Tryptify (monotrypt.android)
                    <ExternalLinkIcon className='size-3' />
                </a>{' '}
                Android app here: open <span className='font-medium'>Settings → Instances → Qobuz URL</span> in the app and paste the URL above.
                {version ? ` Instance API v${version}.` : ''}
            </p>
        </div>
    );
};

export default InstanceModeSection;
