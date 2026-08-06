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
- Import a Spotify playlist and translate every track to its Qobuz equivalent.
- Log in with Spotify to browse and download your own playlists, including private ones and Liked Songs.

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

### Spotify playlist importer (optional)

Pressing **Import Playlist** (or pasting a Spotify playlist link straight into the search bar) reads a public Spotify playlist and translates every track to its Qobuz equivalent, giving you `open.qobuz.com` links you can copy, open, or send straight to the download queue.

It needs a Spotify app — create one at [the Spotify developer dashboard](https://developer.spotify.com/dashboard) and set:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

Without logging in, the importer uses the client-credentials flow and can only read public playlists. Optionally set `SPOTIFY_IMPORT_LIMIT` (default `500`) to change how many tracks a single import pulls in. If the credentials are missing the importer simply reports that the deployment is not configured.

#### Logging in with Spotify

**Log in with Spotify** turns the dialog into a playlist window: your own playlists — private and collaborative ones included, plus Liked Songs — are listed for you to pick, match and download without pasting any links.

To enable it, add the callback URL to your Spotify app's **Redirect URIs**:

```
https://<your-domain>/api/spotify/auth/callback
```

The redirect URI is derived from the incoming request, which is what you want for a plain deployment. Behind a proxy or custom domain, pin it with `SPOTIFY_REDIRECT_URI` so it matches the dashboard entry exactly — Spotify rejects the login otherwise.

Login uses the OAuth authorization-code flow with read-only scopes (`playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `user-read-private`) — the app never writes anything back to Spotify. Tokens live in an encrypted, httpOnly cookie (keyed off `FILE_PROXY_SECRET`, falling back to `SPOTIFY_CLIENT_SECRET`), are refreshed automatically, and are dropped by **Log out**. Access itself is revoked from your [Spotify account's apps page](https://www.spotify.com/account/apps/).

Tracks are matched by ISRC first, which pins the exact recording. When Spotify does not expose one — or Qobuz does not index it — the importer falls back to a scored text search over title, artist and duration, and labels each row with how confident the match is (`ISRC`, `High`, `Medium`, `Low`). Anything that fails to clear the bar is reported as "No Qobuz match" rather than guessing.

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
