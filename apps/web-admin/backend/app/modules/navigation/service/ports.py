"""菜单事务端口，由服务决定提交与回滚边界。"""

from contextlib import AbstractAsyncContextManager
from typing import Protocol

from app.modules.navigation.entity.bo.navigation import Navigation


class NavigationTransaction(Protocol):
    """菜单短事务的数据操作。"""

    async def lock(self) -> None: ...
    async def read(self) -> Navigation | None: ...
    async def save(self, navigation: Navigation, actor: str | None) -> None: ...


class NavigationRepository(Protocol):
    """事务工厂，服务持有其上下文。"""

    def transaction(self) -> AbstractAsyncContextManager[NavigationTransaction]: ...
