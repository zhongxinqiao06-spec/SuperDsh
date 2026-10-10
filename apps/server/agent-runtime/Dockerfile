FROM node:24-bookworm-slim AS harness-runtime
ENV NODE_ENV=production
WORKDIR /runtime
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
# Native modules are installed for Linux, never copied from the Windows build tree.
RUN corepack enable && YARN_ENABLE_IMMUTABLE_INSTALLS=true yarn workspaces focus @superdsh/harness --production
COPY apps/desktop/plugins/harness/lib ./apps/desktop/plugins/harness/lib
COPY apps/desktop/plugins/harness/cordis.patch.yml apps/desktop/plugins/harness/host.cordis.patch.yml ./apps/desktop/plugins/harness/

FROM python:3.12-slim AS agent-runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    NARB_DISABLE_NATIVE_CACHE=1 \
    DSH_HOME=/data/home \
    AGENT_CONNECTOR_DATA_DIR=/data/connector \
    SUPERDSH_AGENT_WORKSPACE=/workspace \
    SUPERDSH_HARNESS_PACKAGE=/opt/runtime/apps/desktop/plugins/harness/package.json
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini git bash ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=harness-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=harness-runtime /runtime /opt/runtime
COPY apps/server/agent-runtime/requirements.txt /opt/worker/requirements.txt
RUN python -c "import json,pathlib; p=pathlib.Path('/opt/runtime/apps/desktop/plugins/harness/node_modules/@agents-anywhere/dsh-bridge-next').resolve()/'lib/bundled-connector'; pathlib.Path('/opt/connector').symlink_to(p)" \
    && pip install --no-cache-dir --no-deps -r /opt/worker/requirements.txt /opt/connector \
    && pip check \
    && useradd --uid 1000 --create-home --home-dir /data/user agent \
    && mkdir -p /data/home /data/connector /data/user /workspace \
    && chown -R 1000:1000 /data /workspace
COPY apps/server/agent-runtime/*.py apps/server/agent-runtime/host.mjs /opt/worker/
USER 1000:1000
WORKDIR /workspace
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=90s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8790/health', timeout=2).read()"]
ENTRYPOINT ["tini", "-g", "--", "python", "/opt/worker/worker.py"]
