"""生产输入 Schema 与实际 VO 必须同步，不把当前实现快照当作旧端全量兼容。"""

import json
from pathlib import Path

from pydantic import BaseModel

from app.modules.identity.entity.vo.dto import (
    LoginInput,
    PasswordInput,
    RefreshInput,
    RegisterInput,
    RoleInput,
    UserCreateInput,
    UserPatchInput,
)
from app.modules.identity.entity.vo.oauth import AuthorizeInput
from app.modules.navigation.entity.vo.dto import MenuInput, MenuResetInput
from app.modules.resources.entity.vo.dto import BindingInput, ResourceInput


def test_input_schemas_match_public_models() -> None:
    """只有可验证的输入结构被导出，凭据样本和运行输出不进入生产目录。"""
    root = Path(__file__).resolve().parents[2] / "contracts"
    models: tuple[type[BaseModel], ...] = (
        LoginInput,
        RegisterInput,
        UserCreateInput,
        UserPatchInput,
        RoleInput,
        PasswordInput,
        RefreshInput,
        AuthorizeInput,
        MenuInput,
        MenuResetInput,
        ResourceInput,
        BindingInput,
    )
    for model in models:
        assert (
            json.loads((root / (model.__name__ + ".schema.json")).read_text(encoding="utf-8"))
            == model.model_json_schema()
        )
