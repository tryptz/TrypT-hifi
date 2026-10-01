# Deploy to Cloudflare Tunnel

## Prerequisites

1. **Cloudflare Account** - Sign up at https://dash.cloudflare.com
2. **Create a Tunnel** - Go to https://dash.cloudflare.com/my-org/tunnels and create a new tunnel
3. **Get your Tunnel Token** - Copy the `CF_TUNNEL_TOKEN` from the tunnel settings page

## Deployment Steps

### Step 1: Configure Environment Variables

Set the `CF_TUNNEL_TOKEN` environment variable in your deployment environment (Railway, Render, or manually):

```bash
export CF_TUNNEL_TOKEN='YOUR_TUNNEL_TOKEN_HERE'
```

### Step 2: Start the Application

```bash
cd ~/TrypT-hifi
docker-compose -f docker-compose.yml up -d
```

This starts:
- The Next.js app on port 3000
- Cloudflare Tunnel (port 8080 internally, accessible via tunnel)

### Step 3: Access the App

Visit `https://your-subdomain.trypT-hifi.com` (replace with your tunnel name)

You should see the TrypT-hifi interface with Deezer, Qobuz, and Apple Music integrations.

## What's Included

- **Deezer Downloader** - Full-track downloads with ARL cookie support
- **Qobuz Downloader** - HiFi (FLAC) and MP3 downloads
- **Apple Music** - Streaming and download support
- **Cloudflare Tunnel** - Secure HTTPS endpoint (no SSL certificate management)

## Troubleshooting

- **Tunnel not starting**: Ensure `CF_TUNNEL_TOKEN` is set and has the correct permissions
- **App not responding**: Check `docker-compose logs` for errors
- **Deezer downloads failing**: Make sure your `DEEZER_ARL` environment variable is set

## Customization

### Change Port
If you need a different port:
```bash
docker-compose -f docker-compose.yml up -d --build
```

### Add More Sources
You can extend the app to support additional music services by modifying `lib/deezer-dl-server.tsx` and `app/api/deezer/download/route.ts` following the same patterns as the existing Qobuz integration.