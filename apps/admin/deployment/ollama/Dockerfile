# syntax=docker/dockerfile:1
FROM ollama/ollama:0.40.16@sha256:910d0d8107b538fb0894e63163eb195de0cc7aefcbc666dc62d3b18f71124592

# 按 Ollama 发布清单锁定模型、模板、参数和配置。构建器逐个校验 SHA-256。
ARG REGISTRY=https://registry.ollama.ai/v2/quentinz/bge-small-zh-v1.5
ADD --checksum=sha256:40f5d717a8c0d9b1eedced30ff7460f27fbb7414fd0f2559160d74ccd04a82c9 ${REGISTRY}/manifests/q8_0 /opt/embedding/manifest
ADD --checksum=sha256:da5e051a49876a2e15447cc83a743897b65707363815cf0109e90b47df273891 ${REGISTRY}/blobs/sha256:da5e051a49876a2e15447cc83a743897b65707363815cf0109e90b47df273891 /opt/embedding/blobs/sha256-da5e051a49876a2e15447cc83a743897b65707363815cf0109e90b47df273891
ADD --checksum=sha256:3fd5f729a230062c5d253e4a2fbe701e5b94f8bd102373900dbe587145aad253 ${REGISTRY}/blobs/sha256:3fd5f729a230062c5d253e4a2fbe701e5b94f8bd102373900dbe587145aad253 /opt/embedding/blobs/sha256-3fd5f729a230062c5d253e4a2fbe701e5b94f8bd102373900dbe587145aad253
ADD --checksum=sha256:b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315 ${REGISTRY}/blobs/sha256:b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315 /opt/embedding/blobs/sha256-b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315
ADD --checksum=sha256:b837481ff8556a29d9bb27ac280c23495a491e7268d8f043f2e617f7f795d089 ${REGISTRY}/blobs/sha256:b837481ff8556a29d9bb27ac280c23495a491e7268d8f043f2e617f7f795d089 /opt/embedding/blobs/sha256-b837481ff8556a29d9bb27ac280c23495a491e7268d8f043f2e617f7f795d089

COPY --chmod=0444 BGE-LICENSE /usr/share/licenses/bge-small-zh-v1.5/LICENSE
COPY --chmod=755 start.sh /usr/local/bin/superdsh-ollama
ENTRYPOINT ["/usr/local/bin/superdsh-ollama"]
CMD ["serve"]
