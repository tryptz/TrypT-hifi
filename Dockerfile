# Production build for the Tryptify (Qobuz) Next.js app.
# Used by BOTH docker-compose (the `tryptify` service) and Railway (Dockerfile
# builder). Steps mirror the verified local flow: npm ci -> next build -> next
# start (which binds to $PORT, so it works on Railway and locally).

FROM node:22-alpine AS build
WORKDIR /app

# Install deps against the lockfile (dev deps included — needed by next build).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# App source (submodule/bot/data excluded via .dockerignore).
COPY . .

# NEXT_PUBLIC_* values are inlined at build time. Railway injects service
# variables as build args; these ARGs let them flow into the build (with
# sensible defaults for a plain `docker build`).
ARG NEXT_PUBLIC_APPLICATION_NAME=Tryptify
ARG NEXT_PUBLIC_APPLE_MUSIC_URL=
ARG NEXT_PUBLIC_APPLE_MUSIC_PORT=7373
ENV NEXT_PUBLIC_APPLICATION_NAME=$NEXT_PUBLIC_APPLICATION_NAME \
    NEXT_PUBLIC_APPLE_MUSIC_URL=$NEXT_PUBLIC_APPLE_MUSIC_URL \
    NEXT_PUBLIC_APPLE_MUSIC_PORT=$NEXT_PUBLIC_APPLE_MUSIC_PORT \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Carry the built app + installed deps forward.
COPY --from=build /app ./

EXPOSE 3000
# `next start -H 0.0.0.0` honors $PORT (Railway) and defaults to 3000 (compose).
CMD ["npm", "run", "start"]
