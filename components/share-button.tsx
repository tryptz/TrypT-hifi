import axios from 'axios';
import React, { useState } from 'react';
import { Loader2Icon, Share2Icon } from 'lucide-react';
import { Button } from './ui/button';
import { useToast } from '@/hooks/use-toast';
import { itemSource } from '@/lib/source-provider';
import { formatTitle, QobuzAlbum, QobuzTrack } from '@/lib/qobuz-dl';

// Shares a link that opens this album, or this track and the rest of its
// album, in Tryptify (lib/share-server.ts). On a phone it opens the share
// sheet; elsewhere it copies the link. The server signs the link, so pasted in
// Discord it shows the cover and a 30-second preview.
const ShareButton = ({
    item,
    album,
    className,
    iconClassName
}: {
    item: QobuzAlbum | QobuzTrack;
    // The album a track is on, when the track itself doesn't carry it.
    album?: QobuzAlbum;
    className?: string;
    iconClassName?: string;
}) => {
    const { toast } = useToast();
    const [busy, setBusy] = useState(false);
    const isTrack = 'album' in item || Boolean(album);
    const albumId = isTrack ? (album ?? (item as QobuzTrack).album)?.id : (item as QobuzAlbum).id;
    if (!albumId) return null;

    const share = async () => {
        setBusy(true);
        try {
            const response = await axios.get('/api/share/link', {
                params: { source: itemSource(album ?? item), album: albumId, track: isTrack ? item.id : undefined }
            });
            const url: string = response.data.data.url;
            const title = formatTitle(item);
            if (navigator.share) {
                try {
                    await navigator.share({ title, url });
                    return;
                } catch (e) {
                    // Dismissed by the person: nothing to do. Refused by the browser: copy instead.
                    if (e instanceof DOMException && e.name === 'AbortError') return;
                }
            }
            try {
                await navigator.clipboard.writeText(url);
                toast({ title: 'Link copied', description: `Opens '${title}' in Tryptify` });
            } catch {
                toast({ title: 'Share link', description: url });
            }
        } catch (e) {
            const error = axios.isAxiosError(e) && typeof e.response?.data?.error === 'string' ? e.response.data.error : 'Could not make a link.';
            toast({ title: 'Share failed', description: error });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Button size='icon' variant='ghost' title={`Share '${formatTitle(item)}' to Tryptify`} onClick={share} disabled={busy} className={className}>
            {busy ? <Loader2Icon className={`animate-spin ${iconClassName ?? ''}`} /> : <Share2Icon className={iconClassName} />}
        </Button>
    );
};

export default ShareButton;
