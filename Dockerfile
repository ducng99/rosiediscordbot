FROM oven/bun:slim AS base
WORKDIR /app

FROM base AS deps

# Toolchain for native addons (sodium-native) in case no prebuilt binary
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM base

# ffmpeg is required by @discordjs/voice for playback
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json index.ts ./
COPY src ./src

RUN mkdir -p /app/output \
    && chown -R 1000:1000 /app

USER bun

ENV NODE_ENV=production \
    OUTPUT_DIR=/app/output
VOLUME /app/output

CMD ["bun", "run", "index.ts"]
