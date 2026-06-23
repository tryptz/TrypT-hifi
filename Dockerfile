# Production multi-stage build for the Next.js (standalone output) app.

FROM node:22-alpine AS base

# --- deps: install with a clean, reproducible lockfile ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: compile the production build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runner: minimal image serving the standalone server ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Standalone server honours PORT/HOSTNAME; bind to all interfaces.
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Runtime token store lives here (mount a volume at /app/data to persist).
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
