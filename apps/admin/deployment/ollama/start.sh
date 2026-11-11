#!/bin/sh
set -eu

if [ "${1:-}" = serve ]; then
  models=${OLLAMA_MODELS:-/root/.ollama/models}
  tag="$models/manifests/registry.ollama.ai/quentinz/bge-small-zh-v1.5/q8_0"
  mkdir -p "$models/blobs" "$(dirname "$tag")"
  if [ -e "$tag" ] && ! cmp -s /opt/embedding/manifest "$tag"; then
    echo '已有 Ollama 模型标签的摘要与项目版本不一致' >&2
    exit 1
  fi

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
  install_file /opt/embedding/manifest "$tag"
fi
exec /bin/ollama "$@"
