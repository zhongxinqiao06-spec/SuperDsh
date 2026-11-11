#!/bin/sh
set -eu

if [ "${1:-}" = serve ]; then
  models=${OLLAMA_MODELS:-/root/.ollama/models}
  tag="$models/manifests/registry.ollama.ai/quentinz/bge-small-zh-v1.5/q8_0"
  mkdir -p "$models/blobs" "$(dirname "$tag")"

  # 数据先于清单落盘。中断后可重跑，其他模型和服务密钥保留在原卷中。
  install_file() {
    if cmp -s "$1" "$2"; then return; fi
    pending=$(mktemp "$2.XXXXXX")
    trap 'rm -f "$pending"' EXIT
    cp "$1" "$pending"
    mv -f "$pending" "$2"
    trap - EXIT
  }
  for blob in /opt/embedding/blobs/*; do
    install_file "$blob" "$models/blobs/${blob##*/}"
  done
  install_file /opt/embedding/manifest "$models/blobs/sha256-$(sha256sum /opt/embedding/manifest | cut -d' ' -f1)"
  # ollama pull 会在本地标签中记录附加元数据。已有标签由 ollama-init 通过 API 核对实际摘要。
  if [ ! -e "$tag" ]; then install_file /opt/embedding/manifest "$tag"; fi
fi
exec /bin/ollama "$@"
