# ─── Optimized for fast builds on Render ─────────────────────────
# Layer order: base → deps (cached) → app code (changes often)
FROM node:20-alpine

WORKDIR /app

# 1. Security: create non-root user first (rarely changes → cached)
RUN addgroup -S telebot && adduser -S telebot -G telebot

# 2. Dependencies layer: only re-runs when package*.json changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 3. Application code: changes most often → last layers
COPY index.js input.json ./
COPY chat.txt ./

# 4. Ensure non-root ownership
RUN chown -R telebot:telebot /app
USER telebot

# 5. Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-7777}/health || exit 1

EXPOSE ${PORT:-7777}

CMD ["node", "index.js"]
