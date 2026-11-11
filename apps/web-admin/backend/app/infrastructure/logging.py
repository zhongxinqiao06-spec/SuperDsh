"""结构化应用日志；请求内容、令牌和服务器配置不进入日志字段。"""

import json
import logging
from datetime import UTC, datetime


class StructuredFormatter(logging.Formatter):
    """只记录稳定事件及显式白名单上下文，避免异常默认展开敏感对象。"""

    def format(self, record: logging.LogRecord) -> str:
        fields = {
            "time": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "event": record.getMessage(),
        }
        for key in ("request_id", "session_id", "run_id", "code"):
            if hasattr(record, key):
                fields[key] = str(getattr(record, key))
        return json.dumps(fields, ensure_ascii=False)


def configure_logging() -> logging.Logger:
    """只配置新平台 logger，不修改第三方或旧平台日志行为。"""
    logger = logging.getLogger("web_admin")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(StructuredFormatter())
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger
