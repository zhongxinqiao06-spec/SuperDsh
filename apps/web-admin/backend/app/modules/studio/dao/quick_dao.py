"""快速创作的候选与引用查询，始终限制到已授权作品及素材所有者。"""

from sqlalchemy import Integer, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.studio.entity.do.models import MediaJob, StudioAsset


class QuickDao:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def references(self, owner: str, project: str, versions: list[str]) -> list[StudioAsset]:
        return list(
            await self.session.scalars(
                select(StudioAsset).where(
                    StudioAsset.owner == owner,
                    StudioAsset.id.in_(versions),
                    (StudioAsset.project.is_(None)) | (StudioAsset.project == project),
                )
            )
        )

    async def candidates(self, project: str) -> list[MediaJob]:
        return list(
            await self.session.scalars(
                select(MediaJob)
                .where(
                    MediaJob.project == project,
                    MediaJob.subject == "quick_" + project,
                    MediaJob.kind == "video",
                )
                .order_by(
                    cast(MediaJob.payload["quickSequence"].as_string(), Integer).desc().nullslast(),
                    MediaJob.id,
                )
            )
        )
