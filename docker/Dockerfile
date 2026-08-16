# syntax=docker/dockerfile:1
#
# Backend image for LinkLingo. Build context = repo ROOT.

FROM oven/bun:1 AS install
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80

COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/vendor ./vendor
COPY package.json bunfig.toml ./
COPY backend ./backend

EXPOSE 80
CMD ["bun", "backend/src/index.ts"]
