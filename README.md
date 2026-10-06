# Qobuz-DL

![Qobuz-DL](https://github.com/user-attachments/assets/45896382-1764-4339-824a-b31f32991480)

---

> [!IMPORTANT]
> This repository does not contain any copyrighted material, or code to illegaly download music. Downloads are provided by the Qobuz API and should only be initiated by the API token owner. The author is **not responsible for the usage of this repository nor endorses it**, nor is the author responsible for any copies, forks, re-uploads made by other users, or anything else related to Qobuz-DL. Any live demo found online of this project is not associated with the authors of this repo. This is the author's only account and repository.

Qobuz-DL provides a fast and easy way to download music using Qobuz in a variety of codecs and formats entirely from the browser.

## Features

- Download any song or album from Qobuz.
- Re-encode audio provided by Qobuz to a variety of different lossless and lossy codecs using FFmpeg.
- Apply metadata to downloaded songs.

## Table of Contents

- [Installation](#installation)
- [Contributing](#contributing)
- [License](#license)

## Installation

Before you begin, ensure you have the following installed:

- **Node.js** (LTS version recommended)  
  Download from: [https://nodejs.org/](https://nodejs.org/)

- **npm** (comes with Node.js)  
  To check if npm is installed, run:
    ```bash
    npm -v
    ```

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/QobuzDL/Qobuz-DL.git
```

### 2. Navigate to the project directory

```bash
cd Qobuz-DL
```

### 3. Install Dependencies

```bash
npm i
```

### 4. Run the development server

```bash
npm run dev
```

## Docker Installation

### 1. Clone the repo

```bash
git clone https://github.com/QobuzDL/Qobuz-DL.git
```

### 2. Navigate to the project directory

```bash
cd Qobuz-DL
```

### 3. Dockerfile build

```bash
docker build -t qobuz-dl .
```

### 4. Docker compose

```bash
docker-compose up -d
```

### Setup .env (IMPORTANT)

Before you can use Qobuz-DL, you need to change the .env file in the root directory. The default configuration will NOT work. QOBUZ_APP_ID and QOBUZ_SECRET must be set to the correct values. To find these you can use [this tool](https://github.com/QobuzDL/Qobuz-AppID-Secret-Tool).
Additionally, in order to download files longer than 30 seconds, a valid Qobuz token is needed. This can be found in the localuser.token key of localstorage on the [official Qobuz website](https://play.qobuz.com/) for any paying members.

#### Deezer Integration (Optional)

Qobuz-DL also includes Deezer as a music source. To enable Deezer downloads (full tracks, not just previews), you need to set the `DEEZER_ARL` environment variable:

1. **Get your Deezer ARL cookie**:
   - Open https://www.deezer.com in a logged-in browser
   - Open DevTools → Application → Cookies → deezer.com
   - Copy the value of the "arl" cookie

2. **Add it to your .env file**:
   ```env
   DEEZER_ARL=your_arl_cookie_value_here
   ```

**Important**: Deezer downloads require authentication via the ARL cookie. Without it, you'll only be able to browse the Deezer catalog and play 30-second previews.

The Deezer downloader can fetch full-length tracks in MP3 128/320 and FLAC (HiFi) quality when using the ARL cookie.

#### TIDAL Integration (Optional)

TIDAL is available as a fourth source (the source button cycles Qobuz → Apple Music → Deezer → TIDAL). It needs a HiFi API, and there are two ways to give it one.

**Option A — your own TIDAL account (recommended).** trypt-hifi logs in to TIDAL itself and *is* the HiFi API: besides powering its own TIDAL source, it answers the HiFi API routes at the site root (`/search/`, `/info/`, `/track/`, `/trackManifests/`, `/album/`, `/artist/`, `/artist/similar/`, `/playlist/`, `/lyrics/`, `/recommendations/`), so Tryptify can add this site under Settings → Connections and detect it as a TIDAL server.

```env
TIDAL_CLIENT_ID=...
TIDAL_CLIENT_SECRET=...
TIDAL_REFRESH_TOKEN=...
# TIDAL_COUNTRY_CODE=US   # optional; detected from the account when unset
```

To get these, run [hifi-api](https://github.com/binimum/hifi-api)'s `tidal_auth/tidal_auth.py` (`pip install -r tidal_auth/requirements.txt`, then run it and approve the login link with a TIDAL account that has a subscription). Copy `client_ID`, `client_secret` and `refresh_token` from the `token.json` it writes. trypt-hifi swaps the refresh token for short-lived access tokens on its own; if TIDAL ever revokes it, the TIDAL routes answer `TIDAL login failed` and you re-run the script.

> [!WARNING]
> Anyone who can reach your site can stream and download through this account, which TIDAL's terms don't allow and can get the account banned. Keep the deployment private (e.g. behind Cloudflare Access) if it's reachable from the internet.

**Option B — an external HiFi API instance**, the same backend Tryptify's "Tidal HiFi URL" setting uses. Used only when Option A isn't configured:

```env
TIDAL_API_BASE=https://your-hifi-instance.example.com
# or several, for failover:
# TIDAL_API_BASE=https://a.example.com,https://b.example.com
```

With either set you can search TIDAL (or paste `tidal.com` album/track/artist links), stream full tracks in the browser, and download tracks and albums through the regular download pipeline. The quality setting maps to TIDAL qualities: Hi-Res → `HI_RES_LOSSLESS` (24-bit FLAC where TIDAL has a hi-res master), CD → `LOSSLESS`, MP3 320 → `HIGH` (AAC 320). When TIDAL delivers a track as DASH segments instead of one file (some accounts get DASH for every quality), trypt-hifi assembles it server-side and serves it from `/api/tidal/stream-file`: FLAC is remuxed losslessly into a plain `.flac`, AAC stays `.m4a`.

**Dolby Atmos:** releases with an Atmos mix get an `ATMOS` badge. Turn on *Prefer Dolby Atmos* in settings (shown while TIDAL is the active source) to download those tracks as the original E-AC-3 JOC `.m4a`, fetched through the instance's `/trackManifests/` endpoint and assembled from its DASH segments server-side. Atmos audio is passed through byte-for-byte (no re-encode) so players still see it as Atmos; the file carries the track's tags (title, artists, album, album artist, track and disc, date, cover, and "Dolby Atmos" as the comment) in its header, which moves none of the audio; tracks without an Atmos mix, or whose Atmos stream TIDAL serves DRM-protected, fall back to the stereo quality. In-browser playback stays stereo, since most browsers can't decode E-AC-3.

### Discord bot integration (optional)

An "Add Bot" button can be shown in the header to let users invite your Discord bot to their server. It only renders when configured, using either of the following:

- `NEXT_PUBLIC_DISCORD_BOT_INVITE` — a full, ready-made bot invite URL. Takes precedence when set.
- `NEXT_PUBLIC_DISCORD_BOT_CLIENT_ID` — your bot's application/client id, used to build a standard OAuth2 authorize URL (`scope=bot applications.commands`). Optionally pair with `NEXT_PUBLIC_DISCORD_BOT_PERMISSIONS` (a permissions integer) to request specific permissions.

If neither is set, the button is hidden.

## Contributing

1. Fork the repository.
2. Create a new branch: `git checkout -b feature-name`.
3. Make your changes.
4. Push your branch: `git push origin feature-name`.
5. Create a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
