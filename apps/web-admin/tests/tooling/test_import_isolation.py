"""在干净解释器检查装配边界，防止工作进程依赖回流到 FastAPI 启动链。"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path


def test_platform_import_excludes_native_worker_libraries() -> None:
    """Office 仅作为可配置工具；未执行工具时不初始化数值与 PDF 渲染器。"""
    source = (
        "import sys; import app.main; "
        "unexpected = sorted(set(sys.modules) & {'numpy', 'openpyxl', 'pypdfium2', 'onnxruntime'}); "
        "assert not unexpected, unexpected"
    )
    root = Path(__file__).resolve().parents[4] / ".superdsh-work/web-admin-validation"
    root.mkdir(parents=True, exist_ok=True)
    # 子解释器独立设置缓存位置，单独执行此用例时也不能向生产模块写回 pyc。
    with tempfile.TemporaryDirectory(prefix="import-isolation-", dir=root) as temporary:
        result = subprocess.run(
            [sys.executable, "-c", source],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            env={**os.environ, "PYTHONPYCACHEPREFIX": temporary},
        )
    assert result.returncode == 0, result.stderr[-4000:]
