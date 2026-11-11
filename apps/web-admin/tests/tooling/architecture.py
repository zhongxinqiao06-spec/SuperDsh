"""基于 AST 检查若依调用方向；检查器和违规样本都留在集中测试目录。"""

import ast
from pathlib import Path


def inspect_python(path: str, source: str) -> list[str]:
    """返回违反依赖边界的原因；语法错误直接使检查失败。"""
    tree = ast.parse(source, filename=path)
    issues: list[str] = []
    controller = "/controller/" in path
    service = "/service/" in path
    dao = "/dao/" in path
    vo = "/entity/vo/" in path
    module = path.split("/modules/", 1)[1].split("/", 1)[0] if "/modules/" in path else None
    for node in ast.walk(tree):
        imports: list[str] = []
        if isinstance(node, ast.Import):
            imports = [item.name for item in node.names]
        elif isinstance(node, ast.ImportFrom):
            imports = [node.module or ""]
        for target in imports:
            if controller and (
                ".dao" in target
                or ".entity.do" in target
                or target.startswith(("sqlalchemy", "subprocess"))
            ):
                issues.append(f"controller 越层访问 {target}")
            if service and ".controller" in target:
                issues.append(f"service 反向依赖 controller: {target}")
            if dao and (
                (".service" in target and not target.endswith(".service.ports"))
                or ".controller" in target
                or target.startswith("fastapi")
            ):
                issues.append(f"dao 反向依赖业务/HTTP: {target}")
            if vo and target.startswith(("sqlalchemy", "subprocess", "httpx", "requests")):
                issues.append(f"VO 存在 I/O 依赖: {target}")
            if module and target.startswith("app.modules."):
                parts = target.split(".")
                if len(parts) > 3 and parts[2] != module and parts[3] in {"dao", "controller"}:
                    issues.append(f"跨模块直接访问内部实现: {target}")
        if (
            dao
            and isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"commit", "rollback"}
        ):
            issues.append("dao 不得提交或回滚业务事务")
    return issues


def main() -> None:
    """只扫描自有后端源码，不扫描固定上游或生成内容。"""
    app = Path(__file__).resolve().parents[2] / "backend" / "app"
    errors = []
    for file in app.rglob("*.py"):
        relative = file.relative_to(app).as_posix()
        for issue in inspect_python(f"/app/{relative}", file.read_text(encoding="utf-8")):
            errors.append(f"{relative}: {issue}")
    if errors:
        raise SystemExit("\n".join(errors))
    print("Python 若依分层检查通过")


if __name__ == "__main__":
    main()
