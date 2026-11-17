#!/bin/sh
# 仅为 Vite 编译子进程设置堆、原生线程和时限；不更改安装或运行容器环境。
set -eu

heap_mb=${BUILD_VITE_HEAP_MB:-1024}
concurrency=${BUILD_VITE_CONCURRENCY:-1}
compile_timeout=${BUILD_COMPILE_TIMEOUT:-900}

check_integer() {
  case "$2" in
    '' | *[!0-9]*) echo "$1 必须为整数" >&2; exit 2 ;;
  esac
  if [ "${#2}" -gt 5 ] || [ "$2" -lt "$3" ] || [ "$2" -gt "$4" ]; then
    echo "$1 超出允许范围" >&2
    exit 2
  fi
}

check_integer BUILD_VITE_HEAP_MB "$heap_mb" 256 16384
check_integer BUILD_VITE_CONCURRENCY "$concurrency" 1 32
check_integer BUILD_COMPILE_TIMEOUT "$compile_timeout" 1 7200

# 明确覆盖宿主机的 Node 参数；原生打包器与线程池分别遵守对应并发环境。
export NODE_OPTIONS="--max-old-space-size=$heap_mb"
export UV_THREADPOOL_SIZE="$concurrency"
export GOMAXPROCS="$concurrency"
export RAYON_NUM_THREADS="$concurrency"
exec timeout --kill-after=30s "${compile_timeout}s" node node_modules/vite/bin/vite.js build --config apps/web-admin/fronted/vite.config.ts
