"""菜单业务值对象。"""

from dataclasses import dataclass
from typing import Literal

Product = Literal["office", "entertainment"]


@dataclass(frozen=True)
class MenuCatalog:
    """产品可配置的全部模块及初始菜单图，公共页面沿用原模块标识。"""

    modules: list[dict[str, object]]
    defaults: list[dict[str, object]]


@dataclass
class Navigation:
    """一次乐观锁更新的菜单聚合。"""

    version: int
    items: list[dict[str, object]]
