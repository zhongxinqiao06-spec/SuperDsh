"""菜单业务值对象。"""

from dataclasses import dataclass


@dataclass
class Navigation:
    """一次乐观锁更新的菜单聚合。"""

    version: int
    items: list[dict[str, object]]
