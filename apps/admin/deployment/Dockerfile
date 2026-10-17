# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS configuration
WORKDIR /app
COPY apps/admin/deployment/init-config.mjs ./init-config.mjs
CMD ["node", "init-config.mjs"]

FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare yarn@4.18.0 --activate
WORKDIR /app
# Keep archive conversion and native compilation bounded on small servers.
# These limits apply only to this build stage, not the running platform.
ENV NEXT_TELEMETRY_DISABLED=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    YARN_NETWORK_CONCURRENCY=2 \
    YARN_TASK_POOL_CONCURRENCY=1 \
    YARN_TASK_POOL_MODE=async \
    npm_config_jobs=1 \
    CMAKE_BUILD_PARALLEL_LEVEL=1 \
    RAYON_NUM_THREADS=1 \
    SUPERDSH_LOW_MEMORY_BUILD=1
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/patches/ ./.yarn/patches/
COPY patches/ ./patches/
COPY vendor/ ./vendor/
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/desktop/ui/package.json ./apps/desktop/ui/package.json
COPY apps/desktop/core/package.json ./apps/desktop/core/package.json
COPY apps/desktop/plugins/harness/package.json ./apps/desktop/plugins/harness/package.json
COPY dsh-community-market/package.json ./dsh-community-market/package.json
COPY dsh-community-fabric/package.json ./dsh-community-fabric/package.json
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    corepack yarn config set --json supportedArchitectures.cpu '["current"]' \
    && corepack yarn install --immutable
COPY . .
RUN node scripts/server.mjs build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl openssh-client procps python3 python3-venv \
    fonts-dejavu-core fonts-noto-cjk fonts-liberation \
    fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data/config /data/runtime /data/files \
    && chown -R node:node /data /app/apps/admin/.next
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SUPERDSH_NATIVE_PLATFORM=1 \
    SUPERDSH_SERVER_HOST=0.0.0.0 \
    SUPERDSH_SERVER_PORT=5174 \
    AGENT_SERVER_PORT=5174 \
    SUPERDSH_DEPLOYMENT_DATA_DIR=/data \
    SUPERDSH_SERVER_DATA_DIR=/data/runtime \
    AGENT_SERVER_FILES_LOCAL_ROOT=/data/files
USER node
EXPOSE 5174
CMD ["node", "apps/admin/deployment/bootstrap.mjs"]
