# ─── Stage 1: Install dependencies ───────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Stage 2: Production image ──────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Security: run as non-root
RUN addgroup -S telebot && adduser -S telebot -G telebot

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application files
COPY package.json ./
COPY index.js ./
COPY chat.txt ./

# Own files by non-root user
RUN chown -R telebot:telebot /app
USER telebot

# Health check (uses the PORT env var, default 7777)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-7777}/health || exit 1

# Expose health check port
EXPOSE ${PORT:-7777}

CMD ["node", "index.js"]
