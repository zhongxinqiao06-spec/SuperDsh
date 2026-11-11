"""控制帧诊断严格收敛为静态类别，不能将子进程输入直接写入应用日志。"""

from .protocol import Fields

_STAGES = {"host-start", "host-ready", "bridge-service", "bridge-start", "host-stop"}
_NAMES = {"TypeError", "SyntaxError", "RangeError", "ReferenceError", "Error", "UnknownError"}
_CODES = {
    "ENOENT",
    "EACCES",
    "EPERM",
    "EADDRINUSE",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "MODULE_NOT_FOUND",
    "ERR_MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "ERR_REQUIRE_ESM",
    "ERR_DLOPEN_FAILED",
    "runtime_bridge_missing",
    "runtime_bridge_not_ready",
}


def safe_startup_diagnostic(message: Fields) -> dict[str, str]:
    """未知值使用固定回退；不保留 message、stack 或任意新增字段。"""
    value = message.get("diagnostic")
    raw = value if isinstance(value, dict) else {}
    stage, name, code = raw.get("stage"), raw.get("name"), raw.get("code")
    return {
        "stage": stage if isinstance(stage, str) and stage in _STAGES else "unknown",
        "name": name if isinstance(name, str) and name in _NAMES else "UnknownError",
        "code": code if isinstance(code, str) and code in _CODES else "unclassified",
    }
