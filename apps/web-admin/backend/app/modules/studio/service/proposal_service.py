"""导演草案先保存基线，再由用户按字段三方合并；不直接覆盖手工工程。"""

from typing import TYPE_CHECKING

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.foundation_dao import FoundationDao
from app.modules.studio.dao.preparation_dao import PreparationDao
from app.modules.studio.dao.studio_dao import StudioDao
from app.modules.studio.entity.bo.foundation import content_hash
from app.modules.studio.entity.bo.proposal_diff import (
    apply_changes,
    proposal_changes,
    validate_director_document,
)
from app.modules.studio.entity.do.foundation_do import StudioCommand
from app.modules.studio.entity.do.preparation_do import StudioProposal
from app.modules.studio.entity.vo.preparation_vo import ProposeDocument, ReviewFields
from app.modules.studio.entity.vo.studio_vo import Document, identifier

if TYPE_CHECKING:
    from app.modules.studio.service.studio_service import StudioService


class ProposalService:
    def __init__(self, studio: "StudioService") -> None:
        self.studio = studio

    async def propose(self, account: Account, project_id: str, body: ProposeDocument) -> dict:
        """保存导演建议及比较基线，不替换用户当前工程。"""
        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.studio.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            proposals = PreparationDao(session)
            fingerprint = content_hash(body.model_dump())
            previous = await proposals.request(project_id, body.requestKey)
            if previous:
                if previous.request_hash != fingerprint:
                    raise DomainError(409, "方案请求号已用于其他内容")
                return {"id": previous.id, "revision": previous.base_revision}
            if project.lifecycle == "archived" or project.revision != body.revision:
                raise DomainError(409, "作品已归档或更新，请重新读取")
            base = await self.studio.documents.read(session, project_id)
            proposed = body.document.model_copy(deep=True)
            validate_director_document(base.model_dump(), proposed.model_dump())
            record = StudioProposal(
                id=identifier(),
                project_id=project_id,
                base_revision=project.revision,
                request_key=body.requestKey,
                request_hash=fingerprint,
                base_document=base.model_dump(),
                proposed_document=proposed.model_dump(),
                state="pending",
            )
            proposals.add(record)
            project.proposal = {
                "id": record.id,
                "revision": project.revision,
                "shots": proposed.model_dump()["shots"],
            }
            return {"id": record.id, "revision": project.revision}

    async def compare(self, account: Account, project_id: str, proposal_id: str) -> dict:
        """逐字段返回基线、当前值和建议，兼容既有尚未审阅的分镜草案。"""
        account.require("products.entertainment")
        account.require("studio.projects.read")
        async with self.studio.database.sessions() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id)
            current = (await self.studio.documents.read(session, project_id)).model_dump()
            proposal = await PreparationDao(session).proposal(project_id, proposal_id)
            if proposal:
                base, suggested = proposal.base_document, proposal.proposed_document
                revision, state = proposal.base_revision, proposal.state
            elif project.proposal and project.proposal.get("id") == proposal_id:
                revision = project.proposal["revision"]
                base = (await dao.snapshot(project, revision)).document
                suggested, state = {**base, "shots": project.proposal["shots"]}, "pending"
            else:
                raise DomainError(404, "草案不存在")
            return {
                "id": proposal_id,
                "baseRevision": revision,
                "revision": project.revision,
                "state": state,
                "changes": proposal_changes(base, suggested, current),
            }

    async def review(
        self, account: Account, project_id: str, proposal_id: str, body: ReviewFields
    ) -> dict:
        """锁定当前修订后仅合并选中字段，拒绝未明确覆盖的手工冲突。"""
        from app.modules.studio.service.studio_service import validate_document

        account.require("products.entertainment")
        account.require("studio.projects.write")
        async with self.studio.database.sessions.begin() as session:
            dao = StudioDao(session)
            project = await dao.project(account.user_id, project_id, lock=True)
            commands = FoundationDao(session)
            fingerprint = content_hash({"proposal": proposal_id, **body.model_dump()})
            prior = await commands.command(account.user_id, project_id, body.requestKey)
            if prior:
                if prior.request_hash != fingerprint:
                    raise DomainError(409, "审阅请求号已用于其他操作")
                return prior.result
            if project.revision != body.revision or project.lifecycle == "archived":
                raise DomainError(409, "作品已更新或归档，请重新审阅")
            proposal = await PreparationDao(session).proposal(project_id, proposal_id)
            if (
                project.proposal is None
                or project.proposal.get("id") != proposal_id
                or (proposal and proposal.state != "pending")
            ):
                raise DomainError(409, "草案已处理或已被新方案替代")
            current = (await self.studio.documents.read(session, project_id)).model_dump()
            base = (
                proposal.base_document
                if proposal
                else (await dao.snapshot(project, project.proposal["revision"])).document
            )
            suggested = (
                proposal.proposed_document
                if proposal
                else {**base, "shots": project.proposal["shots"]}
            )
            document = Document.model_validate(
                apply_changes(
                    current,
                    proposal_changes(base, suggested, current),
                    body.selected,
                    body.overrides,
                )
            )
            document.assets = list(
                dict.fromkeys(
                    [
                        *document.assets,
                        *(ref for s in document.shots for ref in s.references),
                        *(line.role for s in document.shots for line in s.lines),
                    ]
                )
            )
            validate_document(
                document, await dao.assets(account.user_id, project_id), await dao.jobs(project)
            )
            await self.studio.documents.persist(session, account, project, document, "审阅导演方案")
            project.proposal = None
            if proposal:
                proposal.state, proposal.resolution = "reviewed", body.model_dump()
            result = {"revision": project.revision}
            commands.remember(
                StudioCommand(
                    id=identifier(),
                    owner_id=account.user_id,
                    project_id=project_id,
                    operation_key=body.requestKey,
                    request_hash=fingerprint,
                    command_type="proposal.review",
                    result=result,
                )
            )
            return result
