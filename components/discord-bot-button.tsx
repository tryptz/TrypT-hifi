'use client';

import { Button } from '@/components/ui/button';
import { FaDiscord } from '@react-icons/all-files/fa/FaDiscord';

/**
 * Builds the Discord bot authorization (invite) URL.
 *
 * Precedence:
 *  1. NEXT_PUBLIC_DISCORD_BOT_INVITE  - a full, ready-made invite URL.
 *  2. NEXT_PUBLIC_DISCORD_BOT_CLIENT_ID - the bot's application/client id, from
 *     which a standard OAuth2 authorize URL is constructed. Optionally pair with
 *     NEXT_PUBLIC_DISCORD_BOT_PERMISSIONS (a permissions integer).
 *
 * Returns null when the bot has not been configured, in which case the button
 * is not rendered.
 */
const getBotInviteUrl = (): string | null => {
    const explicitInvite = process.env.NEXT_PUBLIC_DISCORD_BOT_INVITE;
    if (explicitInvite) return explicitInvite;

    const clientId = process.env.NEXT_PUBLIC_DISCORD_BOT_CLIENT_ID;
    if (!clientId) return null;

    const permissions = process.env.NEXT_PUBLIC_DISCORD_BOT_PERMISSIONS || '0';
    const params = new URLSearchParams({
        client_id: clientId,
        scope: 'bot applications.commands',
        permissions
    });

    return `https://discord.com/oauth2/authorize?${params.toString()}`;
};

export default function DiscordBotButton() {
    const inviteUrl = getBotInviteUrl();

    if (!inviteUrl) return null;

    return (
        <a href={inviteUrl} target='_blank' rel='noopener noreferrer'>
            <Button variant='outline' className='flex gap-2 items-center'>
                <FaDiscord />
                <span className='hidden sm:inline'>Add Bot</span>
            </Button>
        </a>
    );
}
