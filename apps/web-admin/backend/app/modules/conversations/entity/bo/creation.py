"""创建请求的持久幂等身份；只记录摘要，不把请求内容作为公共会话元数据。"""

import hashlib
import json


def creation_key(owner: str, connector: str, operation: str) -> str:
    """相同客户端操作可在不同设备独立使用；开始执行和导入共用同一作用域。"""
    raw = json.dumps([owner, connector, operation], ensure_ascii=False, separators=(",", ":"))
    return "create:" + hashlib.sha256(raw.encode()).hexdigest()


def creation_fingerprint(mode: str, value: dict[str, object]) -> str:
    """项目、内容、运行配置或导入/执行模式变化不能复用同一创建操作。"""
    selected = [
        mode,
        value.get("externalSessionId"),
        value.get("projectId"),
        value.get("runtimeId"),
        value.get("text", value.get("content")),
        value.get("selections") or {},
        value.get("attachments") or [],
        value.get("runtimeOptions") or {},
        value.get("agentDefinitionId"),
    ]
    return hashlib.sha256(
        json.dumps(selected, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
