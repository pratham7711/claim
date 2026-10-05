# syntax=docker/dockerfile:1
#
# Claim! web app as ONE long-running Node process (`next start` for apps/web).
# Show state lives in that process's memory; the append-only JSONL event log is written to
# $CLAIM_DATA_DIR (default /data), which is a volume. Run exactly one container per data volume.
#
#   docker build -t claim-web .
#   docker run --rm -p 3011:3011 -v claim-data:/data claim-web

ARG NODE_IMAGE=node:26-bookworm-slim

# ---------- all dependencies (dev included: next build needs typescript, tailwind, postcss) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/listing/package.json packages/listing/
COPY packages/llm/package.json packages/llm/
COPY packages/paypal/package.json packages/paypal/
COPY packages/resolver/package.json packages/resolver/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---------- next build ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build -w @claim/web

# ---------- production dependencies only ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/listing/package.json packages/listing/
COPY packages/llm/package.json packages/llm/
COPY packages/paypal/package.json packages/paypal/
COPY packages/resolver/package.json packages/resolver/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3011 \
    CLAIM_DATA_DIR=/data
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web/package.json /app/apps/web/next.config.ts /app/apps/web/tsconfig.json ./apps/web/
COPY --from=build /app/apps/web/build ./apps/web/build
COPY --from=build /app/apps/web/.next ./apps/web/.next
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
WORKDIR /app/apps/web
EXPOSE 3011
CMD ["sh", "-c", "exec /app/node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-3011}\""]
