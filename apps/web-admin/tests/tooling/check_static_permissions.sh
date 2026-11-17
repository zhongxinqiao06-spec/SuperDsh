#!/bin/sh
# 使用真实 Nginx worker 身份读取全部静态制品，不启动服务、不修改文件或挂载用户数据。
set -eu
if [ "$(id -u)" -eq 0 ]; then
  echo '静态权限验收必须以 nginx 非 root 用户运行' >&2
  exit 1
fi
root=/usr/share/nginx/html
test -r "$root/index.html"
invalid=$(find "$root" \
  \( \( -type f -o -type d \) \( ! -user root -o -perm /022 \) \
  -o \( -type d \( ! -readable -o ! -executable \) \) \
  -o \( -type f ! -readable \) \) -print)
if [ -n "$invalid" ]; then
  printf '静态制品不可读取、所有者异常或允许写入：\n%s\n' "$invalid" >&2
  exit 1
fi
printf '静态制品权限通过，uid=%s，文件数=%s\n' "$(id -u)" "$(find "$root" -type f | wc -l)"
