"""单集工程共享写保护；直接访问旧作品入口也不能绕过整剧归档和交付锁。"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.studio.dao.series_dao import SeriesDao
from app.modules.studio.entity.do.models import StudioProject


async def assert_episode_editable(
    session: AsyncSession, account: Account, project: StudioProject
) -> None:
    """写方先持有项目行锁；整剧锁定动作也取得该锁，使两类入口顺序一致。"""
    dao = SeriesDao(session)
    episode = await dao.context(account.user_id, project.id)
    if episode is None:
        return
    if episode.archived:
        raise DomainError(409, "本集已移入整剧历史，工程与素材只读保留")
    series = await dao.series(account.user_id, episode.series_id)
    if series.lifecycle == "archived":
        raise DomainError(409, "所属整剧已归档，请先恢复整剧再继续制作")
    export = (await dao.latest_exports([project.id])).get(project.id)
    if episode.locked or (export and export.id != episode.unlocked_export_id):
        raise DomainError(409, "本集已锁定，请返回分集编排明确解锁后修改；原交付版本仍保留")
