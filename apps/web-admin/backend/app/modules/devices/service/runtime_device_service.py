"""运行实例管理保留 Connector 原有发现、校验与启停协议。"""

from datetime import UTC, datetime
from typing import cast
from uuid import uuid4

from app.infrastructure.errors import DomainError
from app.modules.devices.entity.do.models import DeviceRuntimeRow
from app.modules.devices.entity.vo.device_dto import RuntimeInput
from app.modules.devices.service.device_service import DeviceService
from app.modules.identity.entity.bo.models import Account


def record(value: object) -> dict[str, object]:
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


class RuntimeDeviceService:
    """运行配置属于平台持久事实，远程设备只校验和执行实例动作。"""

    def __init__(self, devices: DeviceService) -> None:
        self.devices = devices

    async def require_configured(
        self, account: Account, connector: str, runtime_id: str, runtime_type: str
    ) -> None:
        """会话导入只读取已配置事实，不要求在线、不发现设备也不启动运行时。"""
        device = await self.devices.own(account, connector, "sessions.run")
        if device.executor_kind == "server-agent":
            if runtime_id != "dsh" or runtime_type != "dsh":
                raise DomainError(403, "server Agent target is managed by the platform")
            return
        async with self.devices.repository.transaction() as dao:
            row = await dao.runtime(connector, runtime_id)
        if not row or row.runtime_type != runtime_type or row.configuration is None:
            raise DomainError(409, "runtime is not configured")

    @staticmethod
    def view(row: DeviceRuntimeRow) -> dict[str, object]:
        return {
            **row.metadata_json,
            "connectorId": row.connector_id,
            "runtimeId": row.runtime_id,
            "id": row.runtime_id,
            "runtimeType": row.runtime_type,
            "runtime": row.runtime_type,
            "name": row.name,
            "config": row.configuration,
            "configured": row.configuration is not None,
            "active": row.active,
            "status": row.status,
            "running": row.status == "running",
            "revision": row.revision,
            "updatedAt": row.updated_at.isoformat(),
        }

    async def listing(
        self, account: Account, connector: str, types: bool = False, discover: bool = False
    ) -> dict[str, object]:
        device = await self.devices.own(
            account, connector, "devices.manage" if discover else "devices.read"
        )
        if device.executor_kind == "server-agent":
            runtime = self.devices.runtime_getter()
            status = runtime.runner.status(account.user_id).get("status") if runtime else "error"
            item = {
                "id": "dsh",
                "runtimeId": "dsh",
                "runtimeType": "dsh",
                "runtime": "dsh",
                "name": "DSH",
                "displayName": "DSH",
                "active": True,
                "configured": True,
                "running": status == "running",
                "status": status,
                "managed": True,
                "config": {},
            }
            return {"connectorId": connector, "runtimeTypes" if types else "runtimes": [item]}
        if discover:
            await self.discover(account, connector)
            device = await self.devices.own(account, connector)
        if types:
            return {
                "connectorId": connector,
                "runtimeTypes": device.metadata_json.get("runtimeTypes", []),
            }
        async with self.devices.repository.transaction() as dao:
            rows = await dao.runtimes(connector)
        return {"connectorId": connector, "runtimes": [self.view(row) for row in rows]}

    async def discover(self, account: Account, connector: str) -> None:
        """单一 discovery 返回类型目录，重复发现不覆盖已保存配置。"""
        response = record(
            await self.devices.call(account, connector, "runtime.discover", {}, "devices.manage")
        )
        descriptors = response.get("runtimeTypes")
        if not isinstance(descriptors, list) or len(descriptors) > 100:
            raise DomainError(502, "invalid runtime type catalog")
        async with self.devices.repository.transaction() as dao:
            await dao.lock(connector)
            device = await dao.device(connector)
            if not device or device.revoked:
                raise DomainError(404, "connector not found")
            normalized = []
            for raw in descriptors:
                descriptor = record(raw)
                runtime_type = descriptor.get("runtimeType")
                if not isinstance(runtime_type, str) or not runtime_type or len(runtime_type) > 100:
                    raise DomainError(502, "invalid runtime type")
                normalized.append(descriptor)
                if not await dao.runtime(connector, runtime_type):
                    await dao.save(
                        DeviceRuntimeRow(
                            connector_id=connector,
                            runtime_id=runtime_type,
                            runtime_type=runtime_type,
                            name=str(descriptor.get("displayName", runtime_type))[:128],
                            configuration=None,
                            active=False,
                            status="stopped",
                            revision=1,
                            metadata_json=descriptor,
                            updated_at=datetime.now(UTC),
                        )
                    )
            device.metadata_json = {**device.metadata_json, "runtimeTypes": normalized}
            await dao.save(device)

    async def _runtime(self, account: Account, connector: str, runtime_id: str) -> DeviceRuntimeRow:
        await self.devices.own(account, connector)
        async with self.devices.repository.transaction() as dao:
            row = await dao.runtime(connector, runtime_id)
        if not row:
            raise DomainError(404, "runtime not found")
        return row

    async def get(self, account: Account, connector: str, runtime_id: str) -> object:
        device = await self.devices.own(account, connector)
        if device.executor_kind == "server-agent":
            if runtime_id != "dsh":
                raise DomainError(404, "runtime not found")
            values = (await self.listing(account, connector))["runtimes"]
            assert isinstance(values, list)
            return values[0]
        return self.view(await self._runtime(account, connector, runtime_id))

    async def create(self, account: Account, connector: str, value: RuntimeInput) -> object:
        device = await self.devices.own(account, connector, "devices.manage")
        if device.executor_kind == "server-agent":
            raise DomainError(409, "server Agent lifecycle is managed by the platform")
        raw = device.metadata_json.get("runtimeTypes", [])
        types = raw if isinstance(raw, list) else []
        descriptor = next(
            (
                record(item)
                for item in types
                if record(item).get("runtimeType") == value.runtimeType
            ),
            None,
        )
        if not descriptor:
            raise DomainError(404, "runtime type not found; discover device first")
        identifier = value.runtimeId or value.runtimeType + "_" + uuid4().hex[:16]
        params = {
            "runtime": value.runtimeType,
            "runtimeId": identifier,
            "name": value.name,
            "config": value.config or {},
            "configRevision": int(datetime.now(UTC).timestamp() * 1000),
        }
        checked = record(
            await self.devices.call(
                account, connector, "runtime.validateConfig", params, "devices.manage"
            )
        )
        if checked.get("ok") is False or checked.get("valid") is False:
            # 设备提供具体配置错误时保留诊断；缺失或非文本结果使用稳定兼容文案。
            message = checked.get("message")
            raise DomainError(
                422,
                message if isinstance(message, str) and message else "invalid runtime config",
            )
        async with self.devices.repository.transaction() as dao:
            await dao.lock(connector)
            rows = await dao.runtimes(connector)
            maximum = descriptor.get("maxInstances", 1)
            if (
                isinstance(maximum, int)
                and maximum > 0
                and sum(row.runtime_type == value.runtimeType for row in rows) >= maximum
            ):
                raise DomainError(409, "runtime instance limit reached")
            if any(
                row.runtime_id == identifier or row.name.casefold() == value.name.casefold()
                for row in rows
            ):
                raise DomainError(409, "runtime name or identity already exists")
            row = DeviceRuntimeRow(
                connector_id=connector,
                runtime_id=identifier,
                runtime_type=value.runtimeType,
                name=value.name,
                configuration=value.config or {},
                active=False,
                status="stopped",
                revision=1,
                metadata_json=descriptor,
                updated_at=datetime.now(UTC),
            )
            await dao.save(row)
        if value.active:
            return await self.mutate(account, connector, identifier, "active", {"active": True})
        return self.view(row)

    async def mutate(
        self,
        account: Account,
        connector: str,
        runtime_id: str,
        action: str,
        value: dict[str, object],
    ) -> object:
        device = await self.devices.own(account, connector, "devices.manage")
        if device.executor_kind == "server-agent":
            raise DomainError(409, "server Agent lifecycle is managed by the platform")
        async with self.devices.repository.transaction() as dao:
            await dao.lock(connector + ":" + runtime_id)
            row = await dao.runtime(connector, runtime_id)
            if not row:
                raise DomainError(404, "runtime not found")
            if row.status == "configuring" or value.get("revision", row.revision) != row.revision:
                raise DomainError(409, "runtime configuration changed")
            if action == "patch":
                name = value.get("name")
                if not isinstance(name, str) or not name.strip() or len(name) > 128:
                    raise DomainError(422, "invalid runtime name")
                row.name, row.revision, row.updated_at = (
                    name.strip(),
                    row.revision + 1,
                    datetime.now(UTC),
                )
                await dao.save(row)
                return self.view(row)
            if action not in {"config", "clear-config", "active"}:
                raise DomainError(404, "runtime action not found")
            config = record(value.get("config", value)) if action == "config" else row.configuration
            active = (
                value.get("active")
                if action == "active"
                else False
                if action == "clear-config"
                else row.active
            )
            if not isinstance(active, bool) or active and config is None:
                raise DomainError(422, "runtime must be configured before activation")
            row.status, row.revision = "configuring", row.revision + 1
            await dao.save(row)
        params: dict[str, object] = {
            "runtime": row.runtime_type,
            "runtimeId": runtime_id,
            "name": row.name,
            "config": config,
            "configRevision": int(datetime.now(UTC).timestamp() * 1000),
        }
        try:
            if action == "config":
                checked = record(
                    await self.devices.call(
                        account, connector, "runtime.validateConfig", params, "devices.manage"
                    )
                )
                if checked.get("ok") is False or checked.get("valid") is False:
                    raise DomainError(422, "invalid runtime configuration")
            if (
                row.active
                and action in {"config", "clear-config"}
                or action == "active"
                and not active
            ):
                await self.devices.call(
                    account, connector, "runtime.stop", params, "devices.manage"
                )
            if active:
                result = record(
                    await self.devices.call(
                        account, connector, "runtime.start", params, "devices.manage"
                    )
                )
                if result.get("ok") is False:
                    raise DomainError(409, "runtime start failed")
            async with self.devices.repository.transaction() as dao:
                await dao.lock(connector + ":" + runtime_id)
                current = await dao.runtime(connector, runtime_id)
                if not current or current.revision != row.revision:
                    raise DomainError(409, "runtime configuration changed")
                current.configuration = None if action == "clear-config" else config
                current.active, current.status, current.updated_at = (
                    active,
                    "running" if active else "stopped",
                    datetime.now(UTC),
                )
                await dao.save(current)
                return self.view(current)
        except BaseException:
            async with self.devices.repository.transaction() as dao:
                current = await dao.runtime(connector, runtime_id)
                if current and current.revision == row.revision:
                    current.status = "error"
                    await dao.save(current)
            raise

    async def catalog(self, account: Account, connector: str, runtime_id: str, kind: str) -> object:
        device = await self.devices.own(account, connector)
        native = device.executor_kind == "server-agent"
        methods = (
            {
                "model": "catalog.listModels",
                "permission": "catalog.listPermissions",
                "commands": "catalog.listAgentPresets",
                "capabilities": "runtime.getCapabilities",
            }
            if native
            else {
                "model": "runtime.modelCatalog",
                "permission": "runtime.permissionCatalog",
                "commands": "runtime.commands",
                "capabilities": "runtime.capabilities",
            }
        )
        if kind not in methods:
            raise DomainError(404, "catalog not found")
        params: dict[str, object] = {"runtimeId": runtime_id}
        if not native:
            runtime = await self._runtime(account, connector, runtime_id)
            if not runtime.active or runtime.configuration is None:
                raise DomainError(409, "runtime is not active")
            params["runtime"] = runtime.runtime_type
        result = await self.devices.call(account, connector, methods[kind], params, "devices.read")
        if native and kind in {"model", "permission"}:
            return self.bridge_catalog(kind, result)
        return result

    @staticmethod
    def bridge_catalog(kind: str, value: object) -> dict[str, object]:
        """DSH 标题与启用状态映射公开目录；选择身份保留为 selectionId。"""
        source = record(value)
        revision = source.get("revision")
        if (
            source.get("runtime") != "dsh"
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 0
        ):
            raise DomainError(502, "DSH catalog revision is invalid")

        def item(raw: object) -> dict[str, object]:
            entry = record(raw)
            if any(
                not isinstance(entry.get(key), str) or not str(entry[key]).strip()
                for key in ("id", "title", "selectionId")
            ) or not isinstance(entry.get("enabled"), bool):
                raise DomainError(502, "DSH catalog item is invalid")
            return {
                "id": entry["id"],
                "displayName": entry["title"],
                "selectionId": entry["selectionId"],
                "description": entry.get("description"),
                "default": entry.get("default") is True,
                "metadata": {
                    **record(entry.get("metadata")),
                    "enabled": entry["enabled"],
                    **(
                        {"disabledReason": entry["disabledReason"]}
                        if isinstance(entry.get("disabledReason"), str)
                        else {}
                    ),
                },
            }

        field = "models" if kind == "model" else "permissions"
        values = source.get(field)
        if not isinstance(values, list):
            raise DomainError(502, "DSH catalog list is invalid")
        items: list[dict[str, object]] = []
        for raw in values:
            converted = item(raw)
            if kind == "model":
                reasoning = record(raw).get("reasoningItems", [])
                if not isinstance(reasoning, list):
                    raise DomainError(502, "DSH reasoning list is invalid")
                converted["reasoningItems"] = [
                    {**item(choice), "fullModelId": record(choice).get("fullModelId")}
                    for choice in reasoning
                ]
            items.append(converted)
        return {
            "runtime": "dsh",
            "runtimeId": "dsh",
            "revision": revision,
            field: items,
            **({"metadata": record(source["metadata"])} if "metadata" in source else {}),
        }
