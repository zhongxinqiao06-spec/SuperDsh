# Pinned community source releases; do not replace with floating registry tags.
FROM golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848 AS compiler
ENV GOTOOLCHAIN=local CGO_ENABLED=0
ADD --checksum=sha256:be6d0bd3696c3a13a35f02d3a0280b64319c67918b4501c5c3d87f96d000085c https://codeload.github.com/minio/minio/tar.gz/refs/tags/RELEASE.2025-10-15T17-29-55Z /tmp/minio.tar.gz
ADD --checksum=sha256:29db22500374169a43951c7cef09daf19e7291ea5ba00ac10f321371b0a35b32 https://codeload.github.com/minio/mc/tar.gz/refs/tags/RELEASE.2025-08-13T08-35-41Z /tmp/mc.tar.gz
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

FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412 AS runtime
COPY --from=compiler /out/ /usr/local/bin/
COPY --from=compiler /licenses/ /usr/share/licenses/superdsh-minio/
COPY --from=compiler /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY init.sh /usr/local/bin/superdsh-minio-init
RUN chmod 755 /usr/local/bin/superdsh-minio-init && mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
