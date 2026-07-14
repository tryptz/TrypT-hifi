# Qobuz-DL Discord Bot

A Discord bot that brings Qobuz search, artwork, song info, downloads, and
album statistics into your server via slash commands.

The bot is a thin client over the Qobuz-DL **web app's HTTP API** — it does not
talk to Qobuz directly. All token/country handling, region logic, and the
signed download proxy live in the web app, so you only need to point the bot at
a running instance.

## Commands

| Command | Description |
| --- | --- |
| `/download <query> [quality]` | Finds a track and downloads it. Attaches the file directly when it fits under Discord's upload limit, otherwise returns a time-limited download button. |
| `/track <query>` | Song info + album art. |
| `/album <query>` | Album art, full tracklist, and metadata. |
| `/search <query> [type]` | Top albums, tracks, or artists for a query. |
| `/stats <query>` | Cool album statistics: hi-res %, peak bit depth / sample rate, total & average length, estimated FLAC size, explicit count, and a per-track length distribution chart. |

`query` accepts free text **or** a Qobuz `open.qobuz.com` URL.

## Prerequisites

1. A running Qobuz-DL web app (see the repo root `README.md`). By default the
   bot expects it at `http://localhost:3000`.
2. A Discord application + bot: <https://discord.com/developers/applications>
   - Copy the **Application (Client) ID** → `DISCORD_CLIENT_ID`
   - Under **Bot**, reset & copy the **token** → `DISCORD_BOT_TOKEN`

## Setup

1. Add the bot variables to your project's root `.env` (gitignored). See
   [`bot/.env.example`](./.env.example) for the full list:

   ```env
   DISCORD_BOT_TOKEN=your-bot-token
   DISCORD_CLIENT_ID=your-application-id
   APP_URL=http://localhost:3000
   # Optional, for instant command updates while developing:
   DISCORD_GUILD_ID=your-test-server-id
   ```

2. Install dependencies (adds `discord.js` and `dotenv`):

   ```bash
   npm install
   ```

3. Register the slash commands (run once, and again whenever commands change):

   ```bash
   npm run bot:register
   ```

4. Start the bot:

   ```bash
   npm run bot
   ```

## Inviting the bot

Use the **"Add Bot"** button in the web app header (configure
`NEXT_PUBLIC_DISCORD_BOT_CLIENT_ID` in `.env`), or build an invite URL manually:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=0
```

## Notes

- Download links produced by `/download` are signed and expire after ~15
  minutes, matching the web app's file proxy.
- Hi-res FLAC files usually exceed Discord's upload limit, so `/download` will
  return a link for them and attach smaller files (e.g. MP3 320) directly.
  Tune the threshold with `BOT_MAX_UPLOAD_MB`.
