"""将业务资源冻结成固定 DSH 预设，执行循环和排队仍只属于 DSH。"""

import asyncio
import json
from collections.abc import Callable
from typing import cast
from weakref import WeakValueDictionary

from app.infrastructure.errors import DomainError
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.entity.bo.resources import Binding
from app.modules.resources.service.resources import ResourceService
from app.modules.runtime.entity.bo.values import Fields
from app.modules.runtime.service.runtime import RuntimeService
from app.modules.skills.service.runs import stable_hash


def engine_tool(binding_id: str, tool_id: str) -> str:
    """引擎名称由冻结绑定派生，同一 Host 的不同会话不会共享可变工具配置。"""
    return "bound_" + stable_hash([binding_id, tool_id])[:40]


def object_value(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def parameters(schema: object) -> dict[str, object]:
    """转换 JSON Schema 的顶层字段到 DSH 工具参数，完整验证仍在 Python 执行。"""
    value = object_value(schema)
    properties = object_value(value.get("properties"))
    required = value.get("required", [])
    return {
        str(key): {
            "type": item.get("type")
            if item.get("type") in {"string", "number", "boolean"}
            else "json",
            "description": str(item.get("description", key)),
            **({"required": True} if isinstance(required, list) and key in required else {}),
        }
        for key, raw in properties.items()
        if (item := object_value(raw))
    }


class AgentBindingService:
    """启动前安装可重放的描述，不安装任意脚本或第二执行引擎。"""

    def __init__(
        self,
        resources: ResourceService,
        conversations: ConversationService,
        runtime: Callable[[], RuntimeService],
    ) -> None:
        self.resources, self.conversations, self.runtime = resources, conversations, runtime
        self._locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()

    async def frozen(self, account: Account, session_id: str) -> Binding:
        """会话上的 bindingId 是唯一运行资源身份，不能由模型参数替换。"""
        data = await self.conversations.binding(account, session_id)
        identifier = data.get("bindingId") if data else None
        if not isinstance(identifier, str):
            raise DomainError(409, "session has no frozen resource binding")
        binding = await self.resources.authorize_binding(account, identifier)
        if binding.session_id != session_id:
            raise DomainError(403, "binding belongs to another session")
        return binding

    async def prepare(
        self, account: Account, session_id: str, bundle: dict[str, object]
    ) -> dict[str, object]:
        """每次选定绑定版本冻结一次资源；重启重装该版本，保留历史执行快照。"""
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            current = await self.conversations.binding(account, session_id) or bundle
            if current.get("bindingId"):
                binding = await self.frozen(account, session_id)
            else:
                definition = object_value(current.get("definition"))
                identifier = definition.get("id")
                if not isinstance(identifier, str):
                    raise DomainError(409, "agent definition is unavailable")
                version = self.conversations.binding_version(current)
                binding = await self.resources.bind(account, session_id, identifier, version)
                await self.conversations.attach_binding(
                    account, session_id, {"bindingId": binding.id}, version
                )
            return await self._install(account, binding)

    async def _install(self, account: Account, binding: Binding) -> dict[str, object]:
        runtime = self.runtime()
        tool_ids: list[str] = []
        descriptions: list[dict[str, object]] = []
        for item in binding.snapshots:
            if item.get("kind") != "tool":
                continue
            descriptor = object_value(item.get("descriptor"))
            identifier = engine_tool(binding.id, str(item["id"]))
            tool_ids.append(identifier)
            descriptions.append(
                {
                    "id": item["id"],
                    "logicalId": item.get("logicalId"),
                    "name": identifier,
                    "guide": descriptor.get("guide", ""),
                }
            )
            await runtime.install_tool(
                account.user_id,
                cast(
                    Fields,
                    {
                        "id": identifier,
                        "name": str(item["name"]),
                        "description": str(
                            item.get("description") or descriptor.get("description", "")
                        ),
                        "revision": int(str(item["version"])),
                        "sessionIds": [binding.session_id],
                        "parameters": parameters(
                            item.get("inputSchema", descriptor.get("inputSchema"))
                        ),
                        "timeoutSeconds": int(str(descriptor.get("timeoutSeconds", 120))),
                    },
                ),
            )
        skills = [item for item in binding.snapshots if item.get("kind") == "skill"]
        if any(isinstance(item.get("program"), dict) for item in skills):
            identifier = engine_tool(binding.id, "skill_control")
            tool_ids.append(identifier)
            await runtime.install_tool(
                account.user_id,
                cast(
                    Fields,
                    {
                        "id": identifier,
                        "name": "技能阶段",
                        "description": "读取绑定技能，启动、提交、修订或取消阶段。工具执行、方案确认和成果收据由平台核验。",
                        "revision": binding.version,
                        "sessionIds": [binding.session_id],
                        "parameters": {
                            "action": {
                                "type": "string",
                                "required": True,
                                "description": "list/start/status/submit/revise/cancel",
                            },
                            "skillId": {"type": "string"},
                            "runId": {"type": "string"},
                            "outputJson": {"type": "string"},
                        },
                    },
                ),
            )
        definition = next((item for item in binding.snapshots if item.get("kind") == "agent"), {})
        instructions = str(definition.get("instructions", ""))
        payload = {
            "tools": descriptions,
            "skills": [
                {
                    key: item.get(key)
                    for key in ("id", "name", "description", "instructions", "program")
                }
                for item in skills
            ],
        }
        prompt = (
            instructions
            + "\n\n以下是本会话冻结的可配置工具与技能。阶段程序须通过技能阶段工具启动并按当前阶段执行。仅凭文字声明不能代替真实执行和用户确认。\n"
            + json.dumps(payload, ensure_ascii=False)
        )
        preset_id = "agent_" + stable_hash(binding.session_id)[:40]
        session = await self.conversations.get_session(account, binding.session_id)
        await runtime.install_preset(
            account.user_id,
            cast(
                Fields,
                {
                    "id": preset_id,
                    "name": str(definition.get("name", "助手")),
                    "description": str(definition.get("description", "")),
                    "prompt": prompt,
                    "toolIds": tool_ids,
                    "revision": binding.version,
                    "externalSessionId": session.get("externalSessionId"),
                },
            ),
        )
        return {"agentPreset": preset_id}
