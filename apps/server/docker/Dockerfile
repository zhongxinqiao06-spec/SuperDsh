FROM node:24-bookworm-slim AS admin

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=export \
    AGENTS_ANYWHERE_API=

WORKDIR /workspace

# Resolve against the one product lockfile, but install only the admin workspace.
# Manifests and patch inputs are needed by Yarn; desktop source is not built.
COPY package.json yarn.lock .yarnrc.yml ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/desktop/ui/package.json apps/desktop/ui/package.json
COPY apps/desktop/core/package.json apps/desktop/core/package.json
COPY apps/desktop/plugins/harness/package.json apps/desktop/plugins/harness/package.json
COPY dsh-community-market/package.json dsh-community-market/package.json
COPY dsh-community-fabric/package.json dsh-community-fabric/package.json
COPY patches ./patches
COPY .yarn/patches ./.yarn/patches
COPY vendor ./vendor
RUN corepack enable \
    && YARN_ENABLE_IMMUTABLE_INSTALLS=true yarn workspaces focus @superdsh/admin

COPY apps/admin ./apps/admin
RUN yarn workspace @superdsh/admin build

FROM python:3.12-slim AS python-base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONPATH=/app/server \
    AGENT_SERVER_DB_BACKEND=postgres \
    AGENT_SERVER_HOST=0.0.0.0 \
    AGENT_SERVER_STATIC_DIR=/app/admin

WORKDIR /app/server
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini git \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv==0.12.0

COPY apps/server/pyproject.toml apps/server/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --python 3.12
COPY apps/server ./
RUN mkdir -p /data

ENTRYPOINT ["tini", "--"]

FROM python-base AS test
WORKDIR /workspace/apps/server
COPY apps/server ./
COPY agents-anywhere/connector /workspace/agents-anywhere/connector
COPY agents-anywhere/contracts /workspace/agents-anywhere/contracts
RUN uv sync --locked --python 3.12
ENV PYTHONPATH=/workspace/apps/server
ENTRYPOINT ["tini", "--", "env", "-u", "AGENT_SERVER_DB_BACKEND", "-u", "AGENT_SERVER_HOST", "-u", "AGENT_SERVER_STATIC_DIR"]
CMD ["uv", "run", "--no-sync", "pytest", "-q"]

FROM python-base AS server
COPY --from=admin /workspace/apps/admin/out /app/admin
VOLUME ["/data"]
EXPOSE 8000
CMD ["uv", "run", "--no-sync", "python", "-m", "agent_server.main"]

FROM python-base AS agent-supervisor
COPY apps/server/agent-supervisor/supervisor.py /opt/supervisor.py
EXPOSE 8090
CMD ["/opt/venv/bin/python", "/opt/supervisor.py"]
