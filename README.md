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

### Browser Qobuz token setup

On Android Chromium, `play.qobuz.com` may refuse to load even in Desktop site mode because the CSS viewport is still below Qobuz's 1024px requirement. Use **Settings → Qobuz Account → Qobuz Login** in the local app instead. It asks Qobuz for the same user auth token through the API and saves only that token in the server token store.

### Download manager & in-app player

Use the **library button** in the top bar (or the playlist button in the player bar) to open the **Library** window, which has three tabs:

- **Queue** — active and pending downloads with live per-item progress, plus cancel/retry.
- **History** — finished downloads (done / error / cancelled), with retry and clear.
- **Saved** — your in-app library as a scrollable, click-to-play playlist with a storage meter.

To play downloads inside the app, turn on **Settings → Save to library**. With it enabled, each downloaded track (and every track of a downloaded album) is also kept in the browser via IndexedDB, so it survives a page reload and can be played from the bottom **player bar** (play/pause, prev/next, seek, volume, shuffle, repeat). The toggle is off by default, so normal downloads still go only to your OS Downloads folder. Note: `ALAC` (m4a) files can't be decoded by the browser — choose `FLAC`, `MP3`, or `AAC` if you want in-app playback.

## Use as a Qobuz instance (Tryptify / monotrypt.android)

This server doubles as a **Qobuz backend "instance"** for the native Android player [**Tryptify (monotrypt.android)**](https://github.com/tryptz/monotrypt.android). Tryptify has no built-in Qobuz backend — its *Instance Mode* points at a running trypt-hifi server, which holds the Qobuz app credentials + token and proxies the catalog and stream-URL requests.

### Connect the app

1. Run this server and make it reachable from your phone (same LAN IP, or a public tunnel — see the Cloudflare tunnel notes).
2. In the local app, open **Settings → Instance Mode** and copy the **Qobuz instance URL** (it also shows a readiness check — it must say *Ready*, which requires `QOBUZ_APP_ID`/`QOBUZ_SECRET` and at least one saved Qobuz token).
3. In the Tryptify Android app, open **Settings → Instances → Qobuz URL** and paste that URL. Set the streaming source to `BOTH` or `QOBUZ_ONLY`.

### Instance API

A self-describing index lives at **`GET /api`** (name, version, readiness/health, and the endpoint catalog) so a client can discover the instance. All responses use a `{ "success": boolean, "data": … }` envelope and CORS is open on `/api/*`. The endpoints Tryptify consumes:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/get-music?q=&offset=` | Search (`data.albums` / `data.tracks` / `data.artists`) |
| `GET /api/get-album?album_id=<slug>` | Album detail with `data.tracks.items[]` |
| `GET /api/get-artist?artist_id=<id>` | Artist detail (`data.artist`: `name.display`, `images.portrait`, `top_tracks[]`) |
| `GET /api/download-music?track_id=&quality=` | Signed stream/download URL at `data.url` (quality `27`/`7`/`6`/`5`) |

The Qobuz token never leaves the server — the app only receives catalog metadata and short-lived signed CDN URLs. To require a shared secret when exposing the API publicly, set `QOBUZ_ADMIN_SECRET` (note: this guards only the token-management endpoints; the read/download endpoints stay open so clients can reach them).

## Contributing

1. Fork the repository.
2. Create a new branch: `git checkout -b feature-name`.
3. Make your changes.
4. Push your branch: `git push origin feature-name`.
5. Create a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
