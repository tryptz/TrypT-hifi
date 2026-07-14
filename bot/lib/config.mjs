// Central bot configuration, sourced entirely from environment variables so the
// bot can be deployed alongside (or separately from) the Qobuz-DL web app.

// Load variables from the project's root .env (gitignored). The web app relies
// on Next.js to do this; the standalone bot process does it here.
import 'dotenv/config';

function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export const config = {
    // Discord credentials.
    get token() {
        return required('DISCORD_BOT_TOKEN');
    },
    get clientId() {
        return required('DISCORD_CLIENT_ID');
    },
    // Optional: register commands to a single guild for instant availability
    // during development (global commands can take up to an hour to propagate).
    guildId: process.env.DISCORD_GUILD_ID || null,

    // Base URL of the running Qobuz-DL web app whose API the bot reuses.
    appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),

    // Optional country code forwarded to the API as the `Token-Country` header.
    tokenCountry: process.env.TOKEN_COUNTRY || null,

    // Default download quality (Qobuz format id) when the user omits one.
    defaultQuality: process.env.BOT_DEFAULT_QUALITY || '27',

    // Largest file the bot will try to upload directly to Discord. Above this it
    // falls back to a download link. Discord's default limit is 25 MB.
    maxUploadBytes: Math.round(parseFloat(process.env.BOT_MAX_UPLOAD_MB || '25') * 1024 * 1024),

    // Accent colour for embeds (hex without the leading #).
    embedColor: parseInt(process.env.BOT_EMBED_COLOR || '5865F2', 16)
};
