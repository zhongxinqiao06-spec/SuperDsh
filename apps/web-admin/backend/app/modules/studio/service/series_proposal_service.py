"""分集 AI 编排复用 DSH 会话和受限建议工具；不调用模型或自动采用正文。"""

from datetime import UTC, datetime

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.series_dao import SeriesDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.do.series_do import SeriesCommand, SeriesProposal
from app.modules.studio.entity.vo.series_vo import (
    CreateSeriesProposal,
    ResolveSeriesProposal,
    SuggestSeriesProposal,
)
from app.modules.studio.entity.vo.studio_vo import identifier
from app.modules.studio.service.foundation_service import authorize
from app.modules.studio.service.series_service import SeriesService, episode_locked


def proposal_view(row: SeriesProposal) -> dict:
    return {
        "id": row.id,
        "state": row.state,
        "base": row.original,
        "suggestions": row.suggestions,
        "instruction": row.instruction,
        "prompt": row.prompt_text,
        "projectId": row.project_id,
        "baseRevision": row.base_revision,
        "createdAt": row.created_at.isoformat(),
    }


class SeriesProposalService:
    def __init__(self, series: SeriesService) -> None:
        self.series = series

    async def list(self, account: Account, identity: str) -> list[dict]:
        authorize(account, "projects.read")
        async with self.series.studio.database.sessions() as session:
            dao = SeriesDao(session)
            series = await dao.series(account.user_id, identity)
            return [
                {**proposal_view(row), "revision": series.revision}
                for row in await dao.proposals(identity)
            ]

    async def create(self, account: Account, identity: str, body: CreateSeriesProposal) -> dict:
        authorize(account, "projects.write")
        account.require("sessions.run")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "series.proposal.create"
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            episodes = await dao.episodes(account.user_id, identity)
            selected = set(body.episodeIds)
            if len(selected) != len(body.episodeIds) or selected - {ep.id for ep in episodes}:
                raise DomainError(422, "请选择本剧中的分集且不能重复")
            chosen = [ep for ep in episodes if ep.id in selected]
            exports = await dao.latest_exports([ep.project_id for ep in chosen])
            if any(episode_locked(ep, exports.get(ep.project_id)) for ep in chosen):
                raise DomainError(409, "已锁定分集不参加 AI 编排，请先调整范围")
            for pending in await dao.proposals(identity):
                if pending.state in {"waiting", "ready"} and selected.intersection(
                    item["episodeId"] for item in pending.original
                ):
                    raise DomainError(409, "所选分集已有待处理建议，请先采用或放弃")
            proposal = SeriesProposal(
                id=identifier(),
                series_id=identity,
                project_id=chosen[0].project_id,
                base_revision=row.revision,
                original=[
                    {"episodeId": ep.id, "title": ep.title, "story": ep.story} for ep in chosen
                ],
                instruction=body.instruction,
                suggestions=[],
                state="waiting",
            )
            dao.add(proposal)
            setting = await dao.settings(identity, row.settings_revision)
            settings = []
            for asset_id in setting.asset_version_ids:
                asset = await StudioDao(session).owned_asset(account.user_id, asset_id)
                settings.append(
                    {
                        "name": asset.definition["name"],
                        "kind": asset.definition["kind"],
                        "description": asset.definition.get("description", "")[:500],
                    }
                )
            continuity = [
                {
                    "number": ep.position,
                    "title": ep.title,
                    "synopsis": ep.story.get("synopsis", "")[:300],
                    "ending": ep.story.get("ending", "")[:200],
                    "confirmed": ep.confirmed_story_revision == ep.story_revision,
                }
                for ep in episodes
                if ep.id not in selected
            ]
            proposal.prompt_text = (
                f"请协助编排《{row.title}》分集故事。整剧构想：{row.brief}。\n用户要求：{body.instruction}\n"
                f"结构：{'连续剧情，需要核对前情和伏笔' if row.narrative_mode == 'continuous' else '单元故事，各集独立但保持共同设定'}；风格：{row.style_brief}。\n"
                f"已确认的本剧设定：{settings}\n其他集前情（仅参考，不可修改）：{continuity}\n"
                f"只允许修改以下分集的故事四段与承接信息：{proposal.original}\n"
                "保留其他集、角色设定和已生成媒体。调用 studio_series_suggest，"
                f"proposalId={proposal.id}，episodes 为 episodeId 和完整 story（synopsis/opening/development/ending/continuity）列表。"
                "仅提交建议，用户会比较后采用；不要直接保存工程或生成媒体。"
            )
            if len(proposal.prompt_text) > 100000:
                raise DomainError(422, "所选分集正文过长，请缩小本次 AI 编排范围")
            row.revision += 1
            row.updated = datetime.now(UTC)
            await session.flush()
            result = {
                **proposal_view(proposal),
                "revision": row.revision,
            }
            dao.add(
                SeriesCommand(
                    id=identifier(),
                    series_id=identity,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    result=result,
                )
            )
            return result

    async def suggest(self, account: Account, project_id: str, body: SuggestSeriesProposal) -> dict:
        """project_id 必须来自认证会话绑定，不能接受客户端自行指定整剧替代。"""
        authorize(account, "projects.write")
        async with self.series.studio.database.sessions.begin() as session:
            dao = SeriesDao(session)
            proposal = await dao.proposal_for_project(account.user_id, project_id, body.proposalId)
            series = await dao.series(account.user_id, proposal.series_id, lock=True)
            # 等待整剧锁期间用户可能已经放弃；重读避免旧 ORM 状态复活迟到建议。
            proposal = await dao.proposal(series.id, body.proposalId)
            suggestions = [item.model_dump() for item in body.episodes]
            if proposal.state == "ready" and content_hash(suggestions) == content_hash(
                proposal.suggestions
            ):
                return {"id": proposal.id, "state": proposal.state}
            if series.lifecycle == "archived" or proposal.state != "waiting":
                raise DomainError(409, "本次编排已结束，迟到建议未写入")
            expected = {item["episodeId"] for item in proposal.original}
            if (
                len(body.episodes) != len(expected)
                or {item.episodeId for item in body.episodes} != expected
            ):
                raise DomainError(422, "建议必须严格对应本次授权的分集范围")
            proposal.suggestions, proposal.state = suggestions, "ready"
            return {"id": proposal.id, "state": "ready", "nextStep": "请在分集编排中对比并采用"}

    async def resolve(
        self, account: Account, identity: str, proposal_id: str, body: ResolveSeriesProposal
    ) -> dict:
        authorize(account, "projects.write")
        async with self.series.studio.database.sessions.begin() as session:
            row, previous, fingerprint = await self.series.begin(
                session, account, identity, body, "series.proposal.resolve:" + proposal_id
            )
            if previous:
                return previous
            dao = SeriesDao(session)
            proposal = await dao.proposal(identity, proposal_id)
            if proposal.state not in {"waiting", "ready"}:
                raise DomainError(409, "该编排建议已处理")
            if body.action == "discard":
                proposal.state = "discarded"
            else:
                if proposal.state != "ready":
                    raise DomainError(409, "建议尚未返回，当前故事已保留")
                original = {item["episodeId"]: item["story"] for item in proposal.original}
                incoming = {item["episodeId"]: item["story"] for item in proposal.suggestions}
                for choice in body.selected:
                    if choice.episodeId not in incoming:
                        raise DomainError(422, "选择超出本次建议范围")
                    ep = await dao.episode(account.user_id, identity, choice.episodeId)
                    export = (await dao.latest_exports([ep.project_id])).get(ep.project_id)
                    if episode_locked(ep, export):
                        raise DomainError(409, "分集已锁定，本次建议未覆盖内容")
                    changed = dict(ep.story)
                    for field in choice.fields:
                        if changed.get(field, "") != original[ep.id].get(field, ""):
                            raise DomainError(
                                409, "选中段落已有手工修改，请重新对比；其他内容已保留"
                            )
                        changed[field] = incoming[ep.id].get(field, "")
                    if changed != ep.story:
                        ep.story = changed
                        ep.story_revision += 1
                proposal.state = "applied"
            return await self.series.finish(session, account, row, body.requestKey, fingerprint)
