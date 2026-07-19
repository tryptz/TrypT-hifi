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

# Next.js standalone output: a minimal server + traced node_modules.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
# server.js reads process.env.PORT (|| 3000) and process.env.HOSTNAME (|| 0.0.0.0).
CMD ["node", "server.js"]
