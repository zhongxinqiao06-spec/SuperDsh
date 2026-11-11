# syntax=docker/dockerfile:1
# 固定源码、摘要与工具链由 deployment/runtime.json 注入，不依赖下架的公共镜像。
ARG GO_IMAGE
ARG ALPINE_IMAGE
FROM ${GO_IMAGE} AS compiler
ARG MINIO_SOURCE
ARG MINIO_SHA256
ARG MC_SOURCE
ARG MC_SHA256
ENV GOTOOLCHAIN=local CGO_ENABLED=0
ADD --checksum=sha256:${MINIO_SHA256} ${MINIO_SOURCE} /tmp/minio.tar.gz
ADD --checksum=sha256:${MC_SHA256} ${MC_SOURCE} /tmp/mc.tar.gz
RUN mkdir /src /client /out /licenses \
    && tar -xzf /tmp/minio.tar.gz --strip-components=1 -C /src \
    && tar -xzf /tmp/mc.tar.gz --strip-components=1 -C /client \
    && cp /src/LICENSE /licenses/minio-LICENSE \
    && cp /client/LICENSE /licenses/mc-LICENSE
WORKDIR /src
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/minio .
WORKDIR /client
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/mc .
FROM ${ALPINE_IMAGE} AS runtime
COPY --from=compiler /out/ /usr/local/bin/
COPY --from=compiler /licenses/ /usr/share/licenses/web-admin-minio/
COPY --from=compiler /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY init.sh /usr/local/bin/web-admin-minio-init
RUN chmod 755 /usr/local/bin/web-admin-minio-init && mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 9000
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
