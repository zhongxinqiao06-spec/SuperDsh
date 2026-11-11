"""独立复现固定 Host 启动；仅使用本地受控模型，不访问业务数据库或真实账号。"""

import asyncio
import hashlib
import json
import os
import re
import sys
import traceback
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[4]


async def diagnose() -> None:
    """每次使用全新 Home，退出时关闭自己创建的 Host 和随机回环网关。"""
    from app.build_metadata import read_build_info
    from app.integrations.dsh.bridge import RuntimeBridge
    from app.integrations.dsh.gateway import ModelGateway
    from app.integrations.dsh.process import HarnessProcess
    from app.integrations.dsh.protocol import Fields, Json, fields
    from app.integrations.dsh.sync import ProjectionSync
    from fixtures.dsh_models import ControlledModels

    directory = await asyncio.to_thread(Path(os.environ["WEB_ADMIN_VALIDATION_DIR"]).resolve)
    assert directory.is_relative_to(ROOT / ".superdsh-work/web-admin-validation")
    directory = directory / uuid4().hex
    owner = "synthetic-runtime-start-" + uuid4().hex
    catalog_path = os.environ.get("WEB_ADMIN_PROBE_CATALOG")
    models: ControlledModels
    if catalog_path:
        public_catalog = await asyncio.to_thread(Path(catalog_path).resolve)
        assert public_catalog.is_relative_to(ROOT / ".superdsh-work/web-admin-validation")

        class PublicCatalog(ControlledModels):
            """仅读取预先导出的无凭据公开目录；生成仍由本地受控模型拦截。"""

            async def catalog(self, owner: str) -> Fields:
                return fields(
                    json.loads(await asyncio.to_thread(public_catalog.read_text, "utf-8"))
                )

        models = PublicCatalog()
    else:
        models = ControlledModels()

    async def authorize(value: str) -> None:
        assert value == owner

    async def tool_call(value: str, request: Fields) -> Json:
        raise AssertionError("启动诊断不允许执行工具")

    gateway = ModelGateway(owner, models, authorize)
    process: HarnessProcess | None = None
    bridge: RuntimeBridge | None = None
    sync: ProjectionSync | None = None
    report: dict[str, object] = {"modelCalls": 0}
    try:
        origin = await gateway.start()
        process = HarnessProcess(
            "node",
            ROOT / "apps/desktop/plugins/harness/package.json",
            directory / "home",
            directory / "workspace",
            {"origin": origin, "secret": gateway.secret},
            owner,
            tool_call,
        )
        await process.start()
        report["status"] = "host-ready"
        bridge = RuntimeBridge()
        await bridge.connect(
            directory / "home",
            "conn_server_" + hashlib.sha256(owner.encode()).hexdigest()[:24],
            str(read_build_info()["version"]),
        )
        report["status"] = "bridge-ready"

        class MemorySink:
            """仅确认新建空 Home 的快照，不写业务数据库。"""

            async def commit(self, user: str, batch: Fields) -> Fields:
                assert user == owner
                return {"streamId": batch["streamId"], "batchSeq": batch["batchSeq"]}

        sync = ProjectionSync(bridge, MemorySink(), owner)
        await sync.start()
        await asyncio.wait_for(sync.ready.wait(), 10)
        report["status"] = "connector-ready"
        native_catalog = fields(await bridge.request("catalog.listModels"))
        native_models = native_catalog.get("models", [])
        report["models"] = (
            [
                {
                    key: fields(item).get(key)
                    for key in (
                        "selectionId",
                        "name",
                        "enabled",
                        "disabledReason",
                        "reason",
                        "metadata",
                    )
                }
                for item in native_models
            ]
            if isinstance(native_models, list)
            else []
        )
    except Exception as error:
        report.update(
            status="failed",
            exceptionType=type(error).__name__,
            code=getattr(error, "code", None),
            traceback="".join(traceback.format_exception(error)),
        )
    finally:
        if sync is not None:
            await sync.close()
        if bridge is not None:
            await bridge.close()
        if process is not None:
            await process.stop()
            report["diagnostics"] = process.diagnostics
            report["exitCode"] = process.process.returncode if process.process else None
        await gateway.close()
        report["modelCalls"] = models.calls
        encoded = json.dumps(report, ensure_ascii=False)
        encoded = encoded.replace(gateway.secret, "[REDACTED]")
        encoded = re.sub(r"(?i)(bearer\s+)[^\s\"\\]+", r"\1[REDACTED]", encoded)
        print(encoded)


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT / "apps/web-admin/backend"))
    sys.path.insert(0, str(ROOT / "apps/web-admin/tests"))
    from app.infrastructure.event_loop import create_event_loop

    with asyncio.Runner(loop_factory=create_event_loop) as runner:
        runner.run(diagnose())
