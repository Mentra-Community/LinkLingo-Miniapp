# syntax=docker/dockerfile:1
#
# Backend image for LinkLingo. Build context = repo ROOT.
#
# The image also carries the built miniapp bundle, which `backend/src/api/
# bundle.api.ts` serves at `<origin>/miniapp`. A phone installed against that
# URL re-fetches the bundle every launch, so shipping the bundle inside the
# same image makes a push to `main` the whole miniapp release.

FROM oven/bun:1 AS install
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY vendor ./vendor
RUN bun install --frozen-lockfile

# ---- Miniapp bundle ---------------------------------------------------------
# `MENTRA_PUBLIC_*` values are inlined by miniapp/build.ts, so the backend
# origin is fixed at build time — the phone runs this bundle from its own disk
# and cannot discover the origin later. Porter passes the app's environment
# variables as build args for every ARG declared here; the default keeps a bare
# `docker build` pointed at dev. /healthz echoes the baked value.
FROM install AS miniapp
ARG MENTRA_PUBLIC_LINKLINGO_BACKEND_URL=https://linklingo-miniapp-dev.mentraglass.com
ENV MENTRA_PUBLIC_LINKLINGO_BACKEND_URL=${MENTRA_PUBLIC_LINKLINGO_BACKEND_URL}

# `zip` is not in the base image, and the builder may run as the non-root
# `bun` user depending on the tag. Same `zip -r` contract as `miniapp:pack`.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/*

COPY miniapp ./miniapp
RUN cd miniapp && bun run build.ts

# Flat zip (miniapp.json at the root, dist/ contents beside it) — the layout
# the phone-side unpacker requires, identical to `mentra-miniapp pack` output.
RUN cd miniapp/dist && zip -qr /app/bundle.zip .

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80

ARG MENTRA_PUBLIC_LINKLINGO_BACKEND_URL=https://linklingo-miniapp-dev.mentraglass.com
ENV MINIAPP_BUNDLE_BACKEND_URL=${MENTRA_PUBLIC_LINKLINGO_BACKEND_URL}

COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/vendor ./vendor
COPY package.json bunfig.toml ./
COPY backend ./backend
COPY --from=miniapp /app/miniapp/dist ./miniapp-bundle/dist
COPY --from=miniapp /app/bundle.zip ./miniapp-bundle/bundle.zip

EXPOSE 80
CMD ["bun", "backend/src/index.ts"]
