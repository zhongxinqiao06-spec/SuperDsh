"""读取正式模型配置文件，不读取旧平台配置、不联网验证或输出明文凭据。"""

from pathlib import Path

from pydantic import ValidationError

from app.modules.models.entity.vo.startup_vo import StartupModels


def load_startup_models(path: Path) -> StartupModels:
    """有界读取并严格校验；错误不附原始 JSON、校验输入或异常上下文。"""
    try:
        with path.open("rb") as source:
            content = source.read(1024 * 1024 + 1)
    except OSError:
        raise RuntimeError(
            "无法读取后端模型启动配置，请检查 WEB_ADMIN_MODEL_DEFAULTS_FILE"
        ) from None
    if len(content) > 1024 * 1024:
        raise RuntimeError("后端模型启动配置不得超过 1 MiB")
    try:
        return StartupModels.model_validate_json(content)
    except ValidationError:
        raise RuntimeError("后端模型启动配置无效，请检查字段、连接引用及默认模型") from None
