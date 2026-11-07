#!/bin/sh
set -eu
umask 077
export MC_CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT
if [ -n "${MINIO_CONFIG_DIRECTORY:-}" ]; then
  MINIO_ROOT_USER="$(cat "$MINIO_CONFIG_DIRECTORY/minio-root-user")"
  MINIO_ROOT_PASSWORD="$(cat "$MINIO_CONFIG_DIRECTORY/minio-root-password")"
  SUPERDSH_MINIO_APP_USER="$(cat "$MINIO_CONFIG_DIRECTORY/minio-app-user")"
  SUPERDSH_MINIO_APP_PASSWORD="$(cat "$MINIO_CONFIG_DIRECTORY/minio-app-password")"
fi
: "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}"
: "${SUPERDSH_MINIO_APP_USER:?}" "${SUPERDSH_MINIO_APP_PASSWORD:?}"
endpoint="${SUPERDSH_MINIO_ENDPOINT:-http://minio:9000}"
mc alias set platform "$endpoint" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing platform/superdsh-files >/dev/null
mc mb --ignore-existing platform/superdsh-temporary >/dev/null
mc anonymous set none platform/superdsh-files >/dev/null
mc anonymous set none platform/superdsh-temporary >/dev/null
if ! mc admin user info platform "$SUPERDSH_MINIO_APP_USER" >/dev/null 2>&1; then
  mc admin user add platform "$SUPERDSH_MINIO_APP_USER" "$SUPERDSH_MINIO_APP_PASSWORD" >/dev/null
fi
cat > "$MC_CONFIG_DIR/policy.json" <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket","s3:ListBucketMultipartUploads"],"Resource":["arn:aws:s3:::superdsh-files","arn:aws:s3:::superdsh-temporary"]},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::superdsh-files/*","arn:aws:s3:::superdsh-temporary/*"]}]}
JSON
mc admin policy create platform superdsh-files "$MC_CONFIG_DIR/policy.json" >/dev/null
mc admin policy attach platform superdsh-files --user "$SUPERDSH_MINIO_APP_USER" >/dev/null
mc alias set application "$endpoint" "$SUPERDSH_MINIO_APP_USER" "$SUPERDSH_MINIO_APP_PASSWORD" >/dev/null
mc ls application/superdsh-files >/dev/null
echo 'Private storage buckets and application access are ready.'
