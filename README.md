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
- **Apple Music support (parallel service):** a self-hosted Apple Music downloader ([ALACarte](https://github.com/tryptz/apple-music-)) runs alongside Tryptify in the same Docker Compose stack. Tryptify handles Qobuz in the browser; the Apple Music service downloads lossless ALAC → FLAC on the server. A header button links straight to it. See [Apple Music service](#apple-music-service-alacarte).

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

### Discord bot integration (optional)

An "Add Bot" button can be shown in the header to let users invite your Discord bot to their server. It only renders when configured, using either of the following:

- `NEXT_PUBLIC_DISCORD_BOT_INVITE` — a full, ready-made bot invite URL. Takes precedence when set.
- `NEXT_PUBLIC_DISCORD_BOT_CLIENT_ID` — your bot's application/client id, used to build a standard OAuth2 authorize URL (`scope=bot applications.commands`). Optionally pair with `NEXT_PUBLIC_DISCORD_BOT_PERMISSIONS` (a permissions integer) to request specific permissions.

If neither is set, the button is hidden.

## Apple Music service (ALACarte)

Tryptify ships with a companion **Apple Music** downloader — [ALACarte](https://github.com/tryptz/apple-music-) — vendored as a git submodule at `./apple-music`. The two run **in parallel**:

- **Tryptify** downloads from **Qobuz**, entirely in the browser, on port `3000`.
- **ALACarte** downloads lossless **Apple Music** (ALAC → FLAC) on the server, on port `7373`, using a self-hosted FairPlay wrapper.

A header **Apple Music** button links straight to the service.

### Requirements

- `linux/amd64` (x86_64) host — the FairPlay wrapper is amd64-only. On Apple Silicon, Docker Desktop emulates via Rosetta.
- Docker + Docker Compose.
- An **Apple Music paid subscription**.

### Run both together (self-hosted)

Because ALACarte's wrapper needs Docker-in-Docker and device mounts, run the combined stack on a VPS or your own machine — not on a PaaS:

```bash
# Clone WITH the submodule (or run the update command below afterwards)
git clone --recurse-submodules <this-repo> tryptify
cd tryptify
git submodule update --init --recursive   # if you cloned without --recurse-submodules

cp .env.example .env                        # set MUSIC_PATH (required)
docker compose up -d --build
```

- Tryptify UI: `http://<your-host>:3000`
- Apple Music UI: `http://<your-host>:7373` — grab the one-time setup token from `docker compose logs alacarte-web`, then add your Apple ID in Settings.

All configuration lives in `.env` (see `.env.example`). Full ALACarte documentation is in [`apple-music/README.md`](./apple-music/README.md).

### Railway (or any single-service PaaS)

Railway runs **only the Tryptify service** — the Apple Music wrapper can't run there. Host ALACarte on a VPS, then in the Railway dashboard set:

- `NEXT_PUBLIC_APPLE_MUSIC_URL` — the public URL of your ALACarte instance (e.g. `https://music.example.com`).

The header **Apple Music** button then points at it. If `NEXT_PUBLIC_APPLE_MUSIC_URL` is left empty, the button instead targets the current host on `NEXT_PUBLIC_APPLE_MUSIC_PORT` (default `7373`) — the right behaviour for the self-hosted compose setup above.

## Contributing

1. Fork the repository.
2. Create a new branch: `git checkout -b feature-name`.
3. Make your changes.
4. Push your branch: `git push origin feature-name`.
5. Create a pull request.

## License

This project is licensed under the [MIT License](LICENSE).
