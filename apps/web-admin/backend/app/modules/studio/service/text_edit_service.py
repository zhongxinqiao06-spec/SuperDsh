"""原稿选段与单场编辑共享范围授权、建议、采用及局部撤回。"""

from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.dao.text_edit_dao import TextEditDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.bo.text_span import relocate, replaced_ranges
from app.modules.studio.entity.do.foundation_do import StudioCommand
from app.modules.studio.entity.do.text_edit_do import StudioTextEdit
from app.modules.studio.entity.vo.studio_vo import Document, identifier
from app.modules.studio.entity.vo.text_edit_vo import CreateTextEdit, ResolveTextEdit, SuggestText

if TYPE_CHECKING:
    from app.modules.studio.service.studio_service import StudioService


def text_edit_view(row: StudioTextEdit, document: Document, revision: int) -> dict:
    target = row.target
    conflict = None
    try:
        if row.state == "applied" and row.applied:
            relocate(row.applied["text"], document.script, row.applied["start"], row.applied["end"])
        else:
            position = relocate(row.base_text, document.script, target["start"], target["end"])
            validate_scene_target(target, document, position)
        if target.get("sceneId") and not any(s.id == target["sceneId"] for s in document.scenes):
            conflict = "关联场次已移除，请重新选择修改范围"
    except DomainError as error:
        conflict = str(error)
    return {
        "id": row.id,
        "scope": target["scope"],
        "label": target["label"],
        "original": row.base_text[target["start"] : target["end"]],
        # 对比面板允许手工调整建议；采用后回看必须展示实际保存的内容。
        "suggestion": (
            row.applied["text"][row.applied["start"] : row.applied["end"]]
            if row.applied
            else row.suggestion
        ),
        "instruction": row.instruction,
        "state": row.state,
        "revision": revision,
        "conflict": conflict,
        "sessionId": target.get("sessionId"),
    }


def validate_scene_target(target: dict, document: Document, position: tuple[int, int]) -> None:
    """场次重新关联正文后，旧建议不能继续向原位置写入。"""
    if target["scope"] != "scene":
        return
    scene = next((s for s in document.scenes if s.id == target.get("sceneId")), None)
    if (
        not scene
        or not scene.scriptRange
        or (scene.scriptRange.start, scene.scriptRange.end) != position
    ):
        raise DomainError(409, "本场正文关联已变化，请重新选择，当前内容已保留")


class TextEditService:
    def __init__(self, studio: "StudioService") -> None:
        self.studio = studio

    async def create(self, account: Account, project_id: str, body: CreateTextEdit) -> dict:
        """用户发送明确范围的改写请求；original 模式仅授权本次范围，不改变全局模式。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        account.require("sessions.run")
        async with self.studio.database.sessions.begin() as session:
            project = await StudioDao(session).project(account.user_id, project_id, lock=True)
            dao = TextEditDao(session)
            fingerprint = content_hash(body.model_dump())
            row = await dao.request(project_id, body.requestKey)
            document = await self.studio.documents.read(session, project_id)
            if row:
                if row.request_hash != fingerprint:
                    raise DomainError(409, "操作号已用于其他修改")
            else:
                if project.lifecycle == "archived" or project.revision != body.revision:
                    raise DomainError(409, "作品已更新或归档，请重新选择正文")
                relocate(document.script, document.script, body.start, body.end)
                label = "选中正文"
                if body.scope == "scene":
                    scene = next((s for s in document.scenes if s.id == body.sceneId), None)
                    if (
                        not scene
                        or not scene.scriptRange
                        or (scene.scriptRange.start, scene.scriptRange.end)
                        != (body.start, body.end)
                    ):
                        raise DomainError(409, "场次正文关联已变化，请重新选择")
                    label = scene.title
                row = StudioTextEdit(
                    id=identifier(),
                    project_id=project_id,
                    request_key=body.requestKey,
                    request_hash=fingerprint,
                    base_revision=body.revision,
                    target={
                        "scope": body.scope,
                        "sceneId": body.sceneId,
                        "start": body.start,
                        "end": body.end,
                        "label": label,
                        "sessionId": await dao.conversation(project_id),
                    },
                    base_text=document.script,
                    instruction=body.instruction,
                    state="waiting",
                )
                dao.add(row)
            view = text_edit_view(row, document, project.revision)
            # 结果必须通过受限工具提交；不从聊天展示文本猜测、解析或自动采用正文。
            view["prompt"] = (
                f"请协助编辑剧本，编辑请求 ID：{row.id}。仅修改「{view['label']}」所选正文。\n"
                f"用户要求：{row.instruction}\n待修改正文：\n{view['original']}\n"
                f"前文：{row.base_text[max(0, row.target['start'] - 1500) : row.target['start']]}\n"
                f"后文：{row.base_text[row.target['end'] : row.target['end'] + 1500]}\n"
                "用户已授权本次局部改写，保留范围外内容和现有工程，不改变全局改编模式。"
                f"调用 studio_text_suggest，传 editId={row.id} 和 replacement（完整替换文本）提交建议。"
                "不要调用其他写入工具，不生成媒体，不直接保存工程；用户将在对比面板采用。"
            )
            return view

    async def list(self, account: Account, project_id: str) -> list[dict]:
        account.require("products.entertainment")
        account.require("studio.projects.read")
        async with self.studio.database.sessions() as session:
            project = await StudioDao(session).project(account.user_id, project_id)
            document = await self.studio.documents.read(session, project_id)
            return [
                text_edit_view(row, document, project.revision)
                for row in await TextEditDao(session).list(project_id)
            ]

    async def suggest(self, account: Account, project_id: str, body: SuggestText) -> dict:
        """DSH 工具仅写建议，取消后的迟到结果拒绝写入。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.studio.database.sessions.begin() as session:
            project = await StudioDao(session).project(account.user_id, project_id, lock=True)
            row = await TextEditDao(session).get(project_id, body.editId)
            if row.state == "ready" and row.suggestion == body.replacement:
                return {"id": row.id, "state": row.state}
            if project.lifecycle == "archived" or row.state != "waiting":
                raise DomainError(409, "本次编辑已结束，请勿重复提交")
            if not body.replacement.strip():
                raise DomainError(422, "建议正文不能为空")
            row.suggestion, row.state = body.replacement, "ready"
            return {"id": row.id, "state": row.state, "nextStep": "请在 AI 编辑面板对比并采用"}

    async def resolve(
        self, account: Account, project_id: str, identity: str, body: ResolveTextEdit
    ) -> dict:
        """采用和撤回只替换授权片段，保留后来修改的其他正文与全部媒体。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.studio.database.sessions.begin() as session:
            project = await StudioDao(session).project(account.user_id, project_id, lock=True)
            commands = FoundationDao(session)
            fingerprint = content_hash({"id": identity, **body.model_dump()})
            prior = await commands.command(account.user_id, project_id, body.requestKey)
            if prior:
                if prior.request_hash != fingerprint:
                    raise DomainError(409, "操作号已用于其他内容")
                return prior.result
            if project.lifecycle == "archived" or project.revision != body.revision:
                raise DomainError(409, "作品已更新，请重新读取对比；当前内容已保留")
            row = await TextEditDao(session).get(project_id, identity)
            document = await self.studio.documents.read(session, project_id)
            if body.action == "discard":
                if row.state not in {"waiting", "ready"}:
                    raise DomainError(409, "本次建议已处理")
                row.state = "discarded"
            else:
                target = row.target
                if target.get("sceneId") and not any(
                    s.id == target["sceneId"] for s in document.scenes
                ):
                    raise DomainError(409, "关联场次已移除，请重新选择")
                if body.action == "apply":
                    if row.state != "ready" or row.suggestion is None:
                        raise DomainError(409, "建议尚未完成或已处理")
                    start, end = relocate(
                        row.base_text, document.script, target["start"], target["end"]
                    )
                    validate_scene_target(target, document, (start, end))
                    replacement = (
                        body.replacement if body.replacement is not None else row.suggestion
                    )
                else:
                    if row.state != "applied" or row.applied is None:
                        raise DomainError(409, "此建议没有可撤回的采用记录")
                    start, end = relocate(
                        row.applied["text"],
                        document.script,
                        row.applied["start"],
                        row.applied["end"],
                    )
                    replacement = row.applied["before"]
                before = document.script[start:end]
                document.script = document.script[:start] + replacement + document.script[end:]
                replaced_ranges(document.scenes, start, end, len(replacement))
                if body.action == "apply":
                    row.applied = {
                        "text": document.script,
                        "start": start,
                        "end": start + len(replacement),
                        "before": before,
                    }
                    row.state = "applied"
                else:
                    row.state = "undone"
                await self.studio.documents.persist(
                    session,
                    account,
                    project,
                    document,
                    "采用 AI 局部修改" if body.action == "apply" else "撤回 AI 局部修改",
                )
            result = {"revision": project.revision, "state": row.state}
            commands.remember(
                StudioCommand(
                    id=identifier(),
                    owner_id=account.user_id,
                    project_id=project_id,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    command_type="text-edit.resolve",
                    result=result,
                )
            )
            return result
