#!/bin/sh
# 只初始化当前 Compose 的私有桶，重跑保留已有对象和凭据。
set -eu
umask 077
export MC_CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT
: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}" "${WEB_ADMIN_STORAGE_BUCKET:?}"
mc alias set storage http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "storage/$WEB_ADMIN_STORAGE_BUCKET" >/dev/null
mc anonymous set none "storage/$WEB_ADMIN_STORAGE_BUCKET" >/dev/null
mc ls "storage/$WEB_ADMIN_STORAGE_BUCKET" >/dev/null
echo '新管理端私有对象存储桶已就绪'
