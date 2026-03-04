# ─────────────────────────────────────────────────────────────
# Stage 1 – install production dependencies only
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm ci --omit=dev

# ─────────────────────────────────────────────────────────────
# Stage 2 – production image
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Security: run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy installed modules from previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy only the application source (no dev files)
COPY server.js ./
COPY package.json ./

# Drop to non-root
USER appuser

# Expose the port (overridden by PORT env var at runtime)
EXPOSE 3000

# Health-check so orchestrators (K8s, ECS, etc.) can probe liveness
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

# Environment defaults (override at runtime)
ENV NODE_ENV=production \
    PORT=3000 \
    CLIENT_URL=https://yourapp.example.com

CMD ["node", "server.js"]