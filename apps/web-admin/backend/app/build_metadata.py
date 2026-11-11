"""读取构建时从权威 manifest 生成的信息，缺失时拒绝伪造版本。"""

import json
import os
from pathlib import Path


def read_build_info() -> dict[str, object]:
    """构建及运行使用相同元信息；调用方负责在打包前生成资源。"""
    path = Path(
        os.environ.get(
            "WEB_ADMIN_BUILD_INFO_PATH", Path(__file__).parents[1] / "resources" / "build-info.json"
        )
    )
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("version"), str):
        raise RuntimeError("构建元信息缺少有效 version")
    return value


__version__ = str(read_build_info()["version"])
