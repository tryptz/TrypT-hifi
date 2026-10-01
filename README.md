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

TIDAL is available as a fourth source (the source button cycles Qobuz → Apple Music → Deezer → TIDAL). It talks to a HiFi API instance, the same backend Tryptify's "Tidal HiFi URL" setting uses:

```env
TIDAL_API_BASE=https://your-hifi-instance.example.com
# or several, for failover:
# TIDAL_API_BASE=https://a.example.com,https://b.example.com
```

With it set you can search TIDAL (or paste `tidal.com` album/track/artist links), stream full tracks in the browser, and download tracks and albums through the regular download pipeline. The quality setting maps to TIDAL qualities: Hi-Res → `HI_RES_LOSSLESS` (falls back to 16-bit `LOSSLESS` when the instance only offers a DASH stream), CD → `LOSSLESS`, MP3 320 → `HIGH` (AAC 320).

**Dolby Atmos:** releases with an Atmos mix get an `ATMOS` badge. Turn on *Prefer Dolby Atmos* in settings (shown while TIDAL is the active source) to download those tracks as the original E-AC-3 JOC `.m4a`, fetched through the instance's `/trackManifests/` endpoint and assembled from its DASH segments server-side. Atmos files are passed through byte-for-byte (no re-encode, no tags) so players still see them as Atmos; tracks without an Atmos mix, or whose Atmos stream TIDAL serves DRM-protected, fall back to the stereo quality. In-browser playback stays stereo, since most browsers can't decode E-AC-3.

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
