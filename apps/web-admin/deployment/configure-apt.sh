#!/bin/sh
# 构建镜像可选择 Debian 镜像；保留发行版、组件和签名校验，默认沿用官方源。
set -eu

apt_directory=${1:-/etc/apt}
mirror=${APT_MIRROR:-}
network_timeout=${BUILD_HTTP_TIMEOUT:-120}
network_retries=${BUILD_HTTP_RETRIES:-3}
download_timeout=${BUILD_DOWNLOAD_TIMEOUT:-1800}

case "$network_timeout:$network_retries:$download_timeout" in
  *[!0-9:]* | :* | *: | *::*) echo '构建网络超时和重试次数必须是整数' >&2; exit 2 ;;
esac
if [ "$network_timeout" -lt 1 ] || [ "$network_timeout" -gt 600 ] || [ "$network_retries" -gt 10 ] || [ "$download_timeout" -lt 1 ] || [ "$download_timeout" -gt 7200 ]; then
  echo '构建网络超时需为 1–600 秒，重试次数需为 0–10 次，总时限需为 1–7200 秒' >&2
  exit 2
fi
if [ ! -d "$apt_directory/apt.conf.d" ]; then
  echo '未找到 Debian APT 配置目录' >&2
  exit 2
fi

if [ -n "$mirror" ]; then
  # 只接受无凭据的 HTTPS 基址，避免把认证信息写入镜像层或构建日志。
  if ! printf '%s\n' "$mirror" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'; then
    echo 'APT_MIRROR 必须是无凭据的 HTTPS 镜像基址' >&2
    exit 2
  fi
  mirror=${mirror%/}
  for source in "$apt_directory/sources.list" "$apt_directory"/sources.list.d/*.list "$apt_directory"/sources.list.d/*.sources; do
    [ -f "$source" ] || continue
    # 新版 deb822 与旧式 sources.list 均只替换官方仓库地址，不改发行版和签名配置。
    sed -i \
      -e "s|https\?://deb.debian.org/debian-security|$mirror/debian-security|g" \
      -e "s|https\?://security.debian.org/debian-security|$mirror/debian-security|g" \
      -e "s|https\?://deb.debian.org/debian|$mirror/debian|g" \
      "$source"
  done
fi

cat > "$apt_directory/apt.conf.d/80superdsh-network" <<EOF
Acquire::Retries "$network_retries";
Acquire::http::Timeout "$network_timeout";
Acquire::https::Timeout "$network_timeout";
EOF
