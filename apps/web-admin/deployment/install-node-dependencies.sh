#!/bin/sh
# 仅约束当前依赖安装进程，避免将 Node 堆或 Yarn 线程设置传给后续编译与运行容器。
# 自定义参数使用 BUILD_ 前缀；Yarn 会严格校验所有 YARN_ 环境变量，不能混入构建私有选项。
set -eu

network_concurrency=${BUILD_YARN_NETWORK_CONCURRENCY:-1}
task_concurrency=${BUILD_YARN_TASK_POOL_CONCURRENCY:-1}
task_mode=${BUILD_YARN_TASK_POOL_MODE:-async}
heap_mb=${BUILD_YARN_HEAP_MB:-768}
download_timeout=${BUILD_DOWNLOAD_TIMEOUT:-1800}

check_integer() {
  case "$2" in
    '' | *[!0-9]*) echo "$1 必须为整数" >&2; exit 2 ;;
  esac
  if [ "$2" -lt "$3" ] || [ "$2" -gt "$4" ]; then
    echo "$1 超出允许范围" >&2
    exit 2
  fi
}
check_integer BUILD_YARN_NETWORK_CONCURRENCY "$network_concurrency" 1 32
check_integer BUILD_YARN_TASK_POOL_CONCURRENCY "$task_concurrency" 1 32
check_integer BUILD_YARN_HEAP_MB "$heap_mb" 128 16384
check_integer BUILD_DOWNLOAD_TIMEOUT "$download_timeout" 1 7200
case "$task_mode" in
  async | workers) ;;
  *) echo 'BUILD_YARN_TASK_POOL_MODE 只能为 async 或 workers' >&2; exit 2 ;;
esac

export NODE_OPTIONS="--max-old-space-size=$heap_mb"
export YARN_NETWORK_CONCURRENCY="$network_concurrency"
export YARN_TASK_POOL_CONCURRENCY="$task_concurrency"
export YARN_TASK_POOL_MODE="$task_mode"
if [ -n "${YARN_NPM_REGISTRY_SERVER:-}" ]; then
  export COREPACK_NPM_REGISTRY="$YARN_NPM_REGISTRY_SERVER"
else
  unset YARN_NPM_REGISTRY_SERVER
fi
# 保留固定 Yarn、锁文件与缓存校验；超出预算时失败退出，不扩大内存自动重试。
exec timeout --kill-after=30s "${download_timeout}s" corepack yarn install --immutable
