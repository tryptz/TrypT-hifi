# syntax=docker/dockerfile:1

# ---- Dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- Build ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Produces .next/standalone (output: "standalone" in next.config.ts)
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Bind all interfaces; the port comes from $PORT (Railway sets it) and falls back to 3000.
ENV HOSTNAME=0.0.0.0

# Tailscale (userspace-networking sidecar): lets the app reach the Apple Music
# wrapper on the tailnet when TS_AUTHKEY is set. Only active at runtime via the
# entrypoint; adds no tailnet exposure when TS_AUTHKEY is unset.
ARG TSVERSION=1.78.1
RUN apk add --no-cache ca-certificates curl \
    && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TSVERSION}_amd64.tgz" \
        | tar -xzf - --strip-components=1 -C /usr/local/bin \
            "tailscale_${TSVERSION}_amd64/tailscale" "tailscale_${TSVERSION}_amd64/tailscaled" \
    && mkdir -p /var/run/tailscale /var/lib/tailscale

# Next.js standalone output: a minimal server + traced node_modules.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
# Entrypoint brings up Tailscale (if TS_AUTHKEY) then execs the CMD.
# server.js reads process.env.PORT (|| 3000) and process.env.HOSTNAME (|| 0.0.0.0).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
