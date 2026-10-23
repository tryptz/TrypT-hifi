# TrypT-hifi

A self-hosted web app for searching, streaming and downloading music from **Qobuz**, **Apple Music**, **Deezer** and **TIDAL**, all from the browser. Downloads can be re-encoded with FFmpeg and tagged with full metadata and cover art.

TrypT-hifi started as a fork of [Qobuz-DL](https://github.com/QobuzDL/Qobuz-DL) and has grown into a multi-source app. It can also act as a TIDAL **HiFi API** server for [Tryptify](#tidal) (the Android hi-fi player).

---

> [!IMPORTANT]
> This repository does not contain any copyrighted material. Downloads come from each service's own API and should only be started by the owner of the account or token being used. The author is **not responsible for how this repository is used, and does not endorse it**, nor for any copies, forks or re-uploads made by other people. Any live demo you find online is not associated with the author.

## Table of Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
    - [Qobuz](#qobuz)
    - [Apple Music](#apple-music)
    - [Deezer](#deezer)
    - [TIDAL](#tidal)
    - [Access password](#access-password)
    - [Discord bot button](#discord-bot-button)
- [Running with Docker](#running-with-docker)
- [Deploying](#deploying)
- [Discord bot](#discord-bot)
- [Project layout](#project-layout)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Four sources in one search bar.** The source button cycles Qobuz → Apple Music → Deezer → TIDAL. You can also paste a link from any of them.
- **Download tracks and whole albums**, one file at a time or as a ZIP, with a download queue in the status bar.
- **Re-encode in the browser** with FFmpeg to FLAC, WAV, ALAC, MP3, AAC or Opus. You choose the bitrate for lossy formats.
- **Metadata and cover art** written into every file, with adjustable cover size and quality.
- **Custom file names** for tracks and ZIPs using variables such as `{artists} - {name}`.
- **In-browser player** (mini player) for full-length streaming where the source allows it.
- **Dolby Atmos** downloads from TIDAL (see [TIDAL](#tidal)).
- **Country picker** for Qobuz, so you can use tokens from different regions in one instance.
- **Light and dark themes**, an installable **PWA**, and a built-in changelog.
- **Optional Discord bot** with search, track/album info, downloads and album stats.

## Quick start

You need **Node.js** (LTS) and **npm**, which comes with it. Check with `node -v` and `npm -v`.

```bash
# 1. Get the code
git clone https://github.com/tryptz/TrypT-hifi.git
cd TrypT-hifi

# 2. Install dependencies
npm install

# 3. Create your settings file, then fill it in (see Configuration below)
cp .env.example .env

# 4. Start the dev server on http://localhost:3000
npm run dev
```

For a production build, run `npm run build` and then `npm run start`.

| Script                 | What it does                                 |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Development server on port 3000              |
| `npm run build`        | Production build (Next.js standalone output) |
| `npm run start`        | Serve the production build on port 3000      |
| `npm run lint`         | Run ESLint                                   |
| `npm run bot`          | Start the Discord bot                        |
| `npm run bot:register` | Register the bot's slash commands            |

## Configuration

All settings live in `.env` in the project root. **[`.env.example`](.env.example) lists every variable with comments**, so treat it as the full reference. The sections below cover what you need for each source.

Every source is optional. Fill in only the ones you want to use.

Shared options:

| Variable                     | Purpose                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `FILE_PROXY_SECRET`          | Signs the short-lived download links. Falls back to `QOBUZ_SECRET` when unset. |
| `CORS_PROXY`, `SOCKS5_PROXY` | Optional outbound proxy used by the source clients.                            |

### Qobuz

```env
QOBUZ_APP_ID=
QOBUZ_SECRET=
QOBUZ_AUTH_TOKENS=[]
```

- `QOBUZ_APP_ID` and `QOBUZ_SECRET` are required. The defaults will not work. You can find them with [this tool](https://github.com/QobuzDL/Qobuz-AppID-Secret-Tool).
- To download more than 30-second previews you need a token from a paid account. It's stored in the `localuser.token` key of local storage on the [Qobuz web player](https://play.qobuz.com/). Put it in `QOBUZ_AUTH_TOKENS`.

### Apple Music

Search and browsing use a MusicKit **developer token**. Set **one** of these:

- **Option A:** a ready-made token in `APPLE_DEVELOPER_TOKEN`.
- **Option B:** let the server create one from your MusicKit key: `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and either `APPLE_PRIVATE_KEY` (the `.p8` contents) or `APPLE_PRIVATE_KEY_PATH`. This needs an Apple Developer Program membership with MusicKit enabled.

Downloading ALAC, hi-res lossless or Atmos from Apple needs a separately run decryption **wrapper** and is off by default. The `APPLE_WRAPPER_*`, `APPLE_DECRYPT_*`, `APPLE_UPLOAD_SECRET` and `TS_*` variables in `.env.example` explain how to connect one, including over Tailscale from a hosted deployment. Background reading is in [`docs/apple-music-atmos-in-tryptify.md`](docs/apple-music-atmos-in-tryptify.md).

### Deezer

Browsing and 30-second previews work with no setup. For full-length downloads (MP3 128/320 and FLAC), add your Deezer **ARL** cookie:

1. Open https://www.deezer.com while logged in.
2. Open DevTools → Application → Cookies → `deezer.com`.
3. Copy the value of the `arl` cookie into `.env`:

```env
DEEZER_ARL=your_arl_cookie_value_here
```

### TIDAL

TIDAL needs a HiFi API, and there are two ways to give it one.

**Option A — your own TIDAL account (recommended).** TrypT-hifi logs in to TIDAL itself and _becomes_ a HiFi API. Besides powering its own TIDAL source, it answers the HiFi API routes at the site root (`/search/`, `/info/`, `/track/`, `/trackManifests/`, `/album/`, `/artist/`, `/artist/similar/`, `/playlist/`, `/lyrics/`, `/recommendations/`). That means Tryptify can add this site under **Settings → Connections** and detect it as a TIDAL server.

```env
TIDAL_CLIENT_ID=...
TIDAL_CLIENT_SECRET=...
TIDAL_REFRESH_TOKEN=...
# TIDAL_COUNTRY_CODE=US   # optional; detected from the account when unset
```

To get these values, run [hifi-api](https://github.com/binimum/hifi-api)'s `tidal_auth/tidal_auth.py` (`pip install -r tidal_auth/requirements.txt`, then run it and approve the login link with a TIDAL account that has a subscription). Copy `client_ID`, `client_secret` and `refresh_token` from the `token.json` it writes. TrypT-hifi swaps the refresh token for short-lived access tokens on its own. If TIDAL ever revokes it, the TIDAL routes answer `TIDAL login failed` and you re-run the script.

> [!WARNING]
> Anyone who can reach your site can stream and download through this account. TIDAL's terms don't allow that, and it can get the account banned. Set an [access password](#access-password), or keep the deployment private some other way (for example behind Cloudflare Access), if it's reachable from the internet.

**Option B — an external HiFi API instance**, the same backend Tryptify's "Tidal HiFi URL" setting uses. It's only used when Option A isn't configured:

```env
TIDAL_API_BASE=https://your-hifi-instance.example.com
# or several, for failover:
# TIDAL_API_BASE=https://a.example.com,https://b.example.com
```

With either option you can search TIDAL (or paste `tidal.com` album/track/artist links), stream full tracks in the browser, and download tracks and albums. The quality setting maps to TIDAL like this:

| TrypT-hifi quality | TIDAL quality     | You get                                     |
| ------------------ | ----------------- | ------------------------------------------- |
| Hi-Res             | `HI_RES_LOSSLESS` | 24-bit FLAC where TIDAL has a hi-res master |
| CD                 | `LOSSLESS`        | 16-bit FLAC                                 |
| MP3 320            | `HIGH`            | AAC 320                                     |

When TIDAL delivers a track as DASH segments instead of a single file (some accounts get DASH for every quality), TrypT-hifi assembles it on the server and serves it from `/api/tidal/stream-file`. FLAC is remuxed losslessly into a plain `.flac`; AAC stays `.m4a`.

#### Dolby Atmos

- Releases with an Atmos mix show an **ATMOS** badge.
- Atmos songs and tracklist rows get a Dolby-mark button that downloads the **Dolby Atmos (.m4a)** file. Atmos albums get two _Dolby Atmos_ entries (ZIP or not) in their download menu. These always give you the Atmos file or an error saying why, never the stereo file instead.
- Turn on **Prefer Dolby Atmos** in settings (shown while TIDAL is the active source) to make _every_ download of those tracks the original E-AC-3 JOC `.m4a`. It's fetched through `/trackManifests/` and assembled from its DASH segments on the server.
- The Atmos audio is passed through byte-for-byte (no re-encode), so players still see it as Atmos. Tags (title, artists, album, album artist, track and disc, date, cover, and "Dolby Atmos" as the comment) are written into the file header without touching the audio.
- Tracks without an Atmos mix, or whose Atmos stream TIDAL serves with DRM, fall back to the stereo quality.
- In-browser playback stays stereo, because most browsers can't decode E-AC-3.

### Access password

Set `ACCESS_PASSWORD` to make the whole site need a password:

- **The site's own pages** ask for it once, at `/unlock`, and then remember it in a cookie (a hash of the password, for a year). Changing the password signs everyone out.
- **Tryptify** asks for it under the server's address (Settings › Connections › Add API, and the web player's Trypt HiFi box) and sends it as the `X-Access-Key` header. Stream links the player fetches by itself (`/api/tidal/stream-file`, `/api/tidal/atmos-file`) carry it as `access_key=` in the address instead, since an audio player can't send headers.
- **The Discord bot** reads the same `ACCESS_PASSWORD` from `.env` and sends it too.

Without the password, API routes answer `401` and pages go to `/unlock`. A few routes stay open because they carry their own proof: signed file links (`/api/file`, `/api/apple/files/…`), the Apple decrypt queue (`APPLE_JOB_QUEUE_TOKEN`) and a job's progress by its token. Leave `ACCESS_PASSWORD` unset and the site is open, as before.

### Discord bot button

An **Add Bot** button can appear in the header so people can invite your Discord bot. It only shows when one of these is set:

- `NEXT_PUBLIC_DISCORD_BOT_INVITE` — a full, ready-made invite URL. Wins when set.
- `NEXT_PUBLIC_DISCORD_BOT_CLIENT_ID` — your bot's application ID, used to build a standard invite URL (`scope=bot applications.commands`). Optionally add `NEXT_PUBLIC_DISCORD_BOT_PERMISSIONS` (a permissions integer).

## Running with Docker

```bash
git clone https://github.com/tryptz/TrypT-hifi.git
cd TrypT-hifi
cp .env.example .env        # fill it in first

docker build -t qobuz-dl .  # the image name docker-compose.yml expects
docker-compose up -d
```

The app is then on http://localhost:3000.

The image uses Next.js standalone output and listens on `$PORT` (default 3000). Its entrypoint can also bring up Tailscale when `TS_AUTHKEY` is set, so a hosted container can reach an Apple Music wrapper on your tailnet. Without `TS_AUTHKEY` it skips that step.

## Deploying

- **Cloudflare Tunnel:** `docker-compose.cloudflare.yml` runs the app next to `cloudflared`, so you get HTTPS without opening ports or managing certificates. Set `CF_TUNNEL_TOKEN` and start it with `./deploy-tunnel.sh <TUNNEL_TOKEN>` or `docker-compose -f docker-compose.cloudflare.yml up -d`. Step-by-step guide: [`DEPLOYMENT.md`](DEPLOYMENT.md).
- **Railway / other PaaS:** the `Dockerfile` works as-is. Set your `.env` values as service variables, and add `TS_AUTHKEY` if you use the Apple Music wrapper over Tailscale.

## Discord bot

The [`bot/`](bot/) folder holds a Discord bot with `/download`, `/track`, `/album`, `/search` and `/stats` slash commands. It talks to a running TrypT-hifi instance over HTTP rather than to the music services directly.

Short version: add `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` and `APP_URL` to `.env`, then run `npm run bot:register` once and `npm run bot`. Full instructions: [`bot/README.md`](bot/README.md).

## Project layout

| Path          | What's there                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `app/`        | Next.js pages, and the HiFi API routes at the site root                                                                     |
| `app/api/`    | Server routes for each source (`apple/`, `deezer/`, `tidal/`; Qobuz routes sit at the top level) plus the signed file proxy |
| `components/` | UI: search bar, player, status bar / queue, settings, dialogs                                                               |
| `lib/`        | Source clients, download jobs, FFmpeg helpers, MP4/FLAC tagging, TIDAL DASH and Atmos handling                              |
| `bot/`        | Discord bot                                                                                                                 |
| `config/`     | Country and storefront lists                                                                                                |
| `docs/`       | Design notes                                                                                                                |

## Contributing

1. Fork the repository.
2. Create a new branch: `git checkout -b feature-name`.
3. Make your changes and run `npm run lint`.
4. Push your branch: `git push origin feature-name`.
5. Open a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
