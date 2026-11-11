"""以违规样本验证架构门禁，避免检查器永远返回成功。"""

from architecture import inspect_python


def test_layer_direction() -> None:
    """控制器不能跳过 service，dao 不能反向编排业务或提交事务。"""
    assert inspect_python("/modules/identity/controller/users.py", "from sqlalchemy import select")
    assert inspect_python(
        "/modules/identity/dao/users.py",
        "from app.modules.identity.service.users import UserService",
    )
    assert inspect_python("/modules/identity/dao/users.py", "session.commit()")
    assert not inspect_python(
        "/modules/identity/controller/users.py",
        "from app.modules.identity.service.users import UserService",
    )
