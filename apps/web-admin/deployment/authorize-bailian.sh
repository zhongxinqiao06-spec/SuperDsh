#!/bin/sh
# 在部署目录运行。只将官方 CLI 的本机回调端口转发给正在授权的管理员。
set -eu
umask 077
binary=$(command -v bl) || { echo '请先在部署主机安装百炼官方 CLI（bl）。' >&2; exit 1; }
backend=$(docker compose ps -q backend)
image=$(docker inspect --format '{{.Image}}' "$backend")
uid=$(docker compose exec -T backend id -u)
gid=$(docker compose exec -T backend id -g)
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
chown "$uid:$gid" "$stage"
# 容器只挂载本次登录的临时目录。CLI 仅监听回环，由 SSH 做端口转发。
docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$uid:$gid" --tmpfs /tmp --entrypoint /bl \
  -e HOME=/tmp -e NO_COLOR=1 -e BAILIAN_CONFIG_DIR=/session -e BAILIAN_NO_UPDATE_CHECK=1 \
  -v "$binary:/bl:ro" -v "$stage:/session" "$image" auth login --console --no-browser
# 通过容器标准输入交接，管理页和 HTTP 服务均不接收云凭据。
docker compose exec -T backend python -m app.modules.models.service.aliyun_cli_install < "$stage/config.json"
