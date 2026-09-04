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

Before you can use Qobuz-DL, you need to change the .env file in the root directory. The default configuration will NOT work.

`QOBUZ_APP_ID` and `QOBUZ_SECRET` are **optional**. Qobuz ships both inside its web-player bundle and rotates them whenever it cuts a new release, so the app resolves them at runtime and re-reads them whenever a signed request is rejected (see `lib/qobuz-credentials.ts`). Leave them blank unless you want to pin known-good values — a stale pin still recovers on its own. If you do want to look them up by hand, you can use [this tool](https://github.com/QobuzDL/Qobuz-AppID-Secret-Tool).

> **Why a stale secret looks like a partial outage:** only `track/getFileUrl` signs its request with the secret. Search, album and artist lookups authenticate with the app id and the user token alone. So when the secret rotates, browsing keeps working and **streaming and downloading stop** — the app looks healthy right up until you press download.

`FILE_PROXY_SECRET` should be set to any long random string (`openssl rand -hex 32`) and kept stable — it signs the `/api/file` and Apple stream URLs. It falls back to `QOBUZ_SECRET` only for backwards compatibility; don't rely on that, since `QOBUZ_SECRET` is optional now and rotates.

Additionally, in order to download files longer than 30 seconds, a valid Qobuz token is needed. This can be found in the localuser.token key of localstorage on the [official Qobuz website](https://play.qobuz.com/) for any paying members.

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
