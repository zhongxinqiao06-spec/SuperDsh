"""创作对话复用 DSH 会话及工具调用，作品身份只能从受信的会话上下文解析。"""

from typing import Any, cast

from pydantic import ValidationError

from app.infrastructure.errors import DomainError
from app.modules.conversations.entity.vo.conversation_dto import CreateSessionInput
from app.modules.conversations.service.conversation_service import ConversationService
from app.modules.identity.entity.bo.models import Account
from app.modules.resources.service.resources import ResourceService
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.dao.text_edit_dao import TextEditDao
from app.modules.studio.entity.vo.preparation_vo import ProposeDocument
from app.modules.studio.entity.vo.studio_vo import (
    AssetInput,
    Batch,
    Document,
    SaveDocument,
    Shot,
    identifier,
)
from app.modules.studio.entity.vo.text_edit_vo import SuggestText
from app.modules.studio.service.media_jobs import MediaJobs
from app.modules.studio.service.studio_service import StudioService


class StudioAgent:
    def __init__(
        self,
        studio: StudioService,
        conversations: ConversationService,
        resources: ResourceService,
        package: dict[str, Any],
        media: MediaJobs,
        text_package: dict[str, Any],
    ) -> None:
        self.media = media
        self.text_package = text_package
        self.studio, self.conversations, self.resources, self.package = (
            studio,
            conversations,
            resources,
            package,
        )

    async def conversation(
        self,
        account: Account,
        project_id: str,
        agent_id: str | None = None,
        *,
        text_edit: bool = False,
    ) -> str:
        account.require("products.entertainment")
        account.require("studio.projects.write")
        project = await self.studio.open(account, project_id)
        if project["lifecycle"] == "archived":
            raise DomainError(409, "请先恢复作品，再打开导演会话")
        existing = project["sessionId"]
        if text_edit:
            async with self.studio.database.sessions() as session:
                existing = await TextEditDao(session).conversation(project_id)
        if existing:
            await self.conversations.get_session(account, existing)
            return str(existing)
        if text_edit:
            agent_id = (await self.resources.initialize_product(account, self.text_package))[
                "editor"
            ]
        elif agent_id:
            bundle = await self.resources.published_bundle(account, agent_id)
            if cast(dict, bundle["definition"]).get("product", "office") != "entertainment":
                raise DomainError(403, "此智能体未发布到星桥娱乐")
        else:
            agent_id = (await self.resources.initialize_product(account, self.package))["director"]
        devices = self.conversations.devices
        await devices.ensure_native(account.user_id)
        await self.conversations.projects.ensure_native(account.user_id)
        connector, workspace = devices.native_ids(account.user_id)
        result = await self.conversations.create(
            account,
            CreateSessionInput(
                connectorId=connector,
                projectId=workspace,
                clientMessageId=("studio-text-" if text_edit else "studio-") + project_id,
                title=project["title"],
                agentDefinitionId=agent_id,
            ),
            start=False,
            product="entertainment",
        )
        session_id = str(cast(dict, result["session"])["id"])
        async with self.studio.database.sessions.begin() as session:
            row = await StudioDao(session).project(account.user_id, project_id, lock=True)
            if text_edit:
                await TextEditDao(session).attach(project_id, session_id)
            else:
                row.session_id = session_id
        return session_id

    async def runtime_status(
        self, account: Account, project_id: str, *, prepare: bool, text_edit: bool = False
    ) -> dict:
        """只有作品所有者可为其导演会话准备和查询引擎，创作者无需设备管理权限。"""
        account.require("products.entertainment")
        account.require("sessions.run")
        async with self.studio.database.sessions() as session:
            project = await StudioDao(session).project(account.user_id, project_id)
            session_id = project.session_id
            if text_edit:
                session_id = await TextEditDao(session).conversation(project_id)
        if not session_id:
            raise DomainError(409, "请先打开本作品的导演会话")
        row = await self.conversations.own(account, session_id, "sessions.run")
        if row.source.get("product") != "entertainment":
            raise DomainError(409, "作品会话与产品不匹配")
        runtime = self.conversations.devices.runtime_getter()
        if not runtime:
            raise DomainError(503, "服务端 Agent 未就绪")
        state = (
            await runtime.prepare(account.user_id)
            if prepare
            else await runtime.view(account.user_id)
        )
        return {"agent": state}

    async def refresh_conversation(
        self,
        account: Account,
        project_id: str,
        agent_id: str | None = None,
        *,
        text_edit: bool = False,
    ) -> dict:
        """用户确认后更新预置助手工具；保留作品、会话历史和旧冻结绑定。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("sessions.run")
        project = await self.studio.open(account, project_id)
        if project["lifecycle"] == "archived":
            raise DomainError(409, "请先恢复作品，再更新助手工具")
        package = self.text_package if text_edit else self.package
        ids = await self.resources.initialize_product(account, package)
        expected_agent = ids["editor" if text_edit else "director"]
        if agent_id and agent_id != expected_agent:
            raise DomainError(409, "当前是自定义或其他账号发布的助手，请由发布者在工具管理中更新")
        existing = project["sessionId"]
        if text_edit:
            async with self.studio.database.sessions() as session:
                existing = await TextEditDao(session).conversation(project_id)
        row = (
            await self.conversations.own(account, str(existing), "sessions.run")
            if existing
            else None
        )
        if row:
            definition = (row.agent_binding or {}).get("definition", {})
            if not isinstance(definition, dict) or definition.get("id") != expected_agent:
                raise DomainError(409, "当前会话使用自定义助手，请由发布者更新后重新绑定")
            if row.status not in {"idle", "error"} or row.archived or not row.takeover:
                raise DomainError(409, "请等待或取消当前任务后，再更新助手工具")
        updated = await self.resources.refresh_product_tools(account, package)
        if row:
            await self.conversations.bind_agent(
                account,
                row.id,
                expected_agent,
                self.conversations.binding_version(row.agent_binding),
            )
            session_id = row.id
        else:
            session_id = await self.conversation(
                account, project_id, expected_agent, text_edit=text_edit
            )
        return {"sessionId": session_id, "agentId": expected_agent, "updatedTools": updated}

    async def execute(
        self,
        account: Account,
        tool: str,
        arguments: dict[str, object],
        settings: dict[str, object],
        context: dict[str, object],
    ) -> dict[str, object]:
        account.require("products.entertainment")
        async with self.studio.database.sessions() as session:
            locator = TextEditDao(session) if tool == "studio_text_suggest" else StudioDao(session)
            project_id = await locator.by_conversation(
                account.user_id, str(context.get("sessionId", ""))
            )
        if not project_id:
            raise DomainError(403, "请从作品打开创作对话")
        project = await self.studio.open(account, project_id)
        if tool != "studio_read":
            account.require("studio.projects.write")
            if project["lifecycle"] == "archived":
                raise DomainError(409, "请先恢复作品，再继续编辑")
        data = dict(arguments)
        if tool == "studio_generate":
            receipt = context.get("receiptId")
            if not isinstance(receipt, str) or not receipt:
                raise DomainError(409, "缺少工具调用收据")
            batch = Batch.model_validate({**data, "requestKey": receipt})
            if context.get("phase") == "prepare":
                items = await self.media.submit(account, project_id, batch, preview=True)
                plan = {
                    "title": "制作镜头与配音",
                    "summary": f"作品「{project['title']}」将提交 {len(items)} 项媒体任务",
                    "items": items,
                }
                return {
                    "structuredContent": {"plan": plan, "planHash": self.media.plan_hash(items)}
                }
            approved = context.get("authorizedPlanHash")
            if (
                context.get("phase") != "execute"
                or not isinstance(approved, str)
                or len(approved) != 64
            ):
                raise DomainError(409, "生成前请先确认方案")
            jobs = await self.media.submit(account, project_id, batch, approved_hash=approved)
            return {"structuredContent": {"jobs": jobs}}
        if tool == "studio_read":
            return {"structuredContent": project}
        if tool == "studio_asset":
            result = await self.studio.asset(
                account, AssetInput.model_validate({**data, "project": project_id})
            )
            return {"structuredContent": result}
        if tool == "studio_text_suggest":
            result = await self.studio.text_edits.suggest(
                account,
                project_id,
                SuggestText.model_validate(
                    {"editId": data["editId"], "replacement": data.get("replacement")}
                ),
            )
            return {"structuredContent": result}
        rev = data.pop("revision", None)
        if rev != project["revision"]:
            raise DomainError(409, "工程已更新，请重新读取")
        if tool == "studio_propose":
            try:
                proposed = Document.model_validate({**project["document"], **data})
            except ValidationError as error:
                # 不把 Pydantic 的原始输入/上下文回传给模型；只提供有界字段提示以便纠正草案。
                issues = [
                    ".".join(str(part)[:80] for part in issue["loc"][:8])
                    + ": "
                    + issue["msg"][:200]
                    for issue in error.errors(
                        include_url=False, include_context=False, include_input=False
                    )[:4]
                ]
                raise DomainError(
                    422,
                    "分镜方案字段格式无效，请修正后重新提交：" + "；".join(issues),
                    "studio_tool_arguments_invalid",
                ) from None
            result = await self.studio.proposals.propose(
                account,
                project_id,
                ProposeDocument(
                    revision=rev,
                    requestKey=str(context.get("receiptId") or identifier()),
                    document=proposed,
                ),
            )
            return {
                "structuredContent": {
                    **result,
                    "proposed": len(proposed.shots),
                    "nextStep": "请在作品的导演方案对比中逐字段审阅",
                }
            }
        if tool != "studio_edit":
            raise DomainError(422, "未知创作工具")
        shot_id = data.pop("shotId", None)
        document = Document.model_validate(project["document"])
        shot = next((s for s in document.shots if s.id == shot_id), None)
        if not shot:
            raise DomainError(404, "镜头不存在")
        document.shots[document.shots.index(shot)] = Shot.model_validate(
            {**shot.model_dump(), **data}
        )
        from app.modules.studio.entity.bo.proposal_diff import validate_director_document

        validate_director_document(project["document"], document.model_dump())
        changed = await self.studio.save(
            account,
            project_id,
            SaveDocument(revision=project["revision"], document=document, label="导演修改镜头"),
        )
        return {"structuredContent": changed}
