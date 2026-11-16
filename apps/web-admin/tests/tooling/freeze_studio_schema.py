"""开发期冻结创作基础迁移 DDL；历史迁移运行时不导入可变 ORM。"""

import importlib
import inspect
import json
from pathlib import Path

from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import (
    AddConstraint,
    CreateIndex,
    CreateTable,
    sort_tables_and_constraints,
)

from app.infrastructure.database import Base
from app.modules.studio.entity.bo.document_projection import project_rows
from app.modules.studio.entity.bo.foundation import stable_id

backend = Path(__file__).resolve().parents[2] / "backend"
for source in sorted((backend / "app/modules").glob("*/entity/do/*.py")):
    if source.stem != "__init__":
        importlib.import_module(".".join(source.relative_to(backend).with_suffix("").parts))

legacy = {
    "studio_projects",
    "studio_revisions",
    "studio_assets",
    "studio_media_jobs",
    "studio_stage_reviews",
    "studio_proposals",
    "studio_generation_plans",
    "studio_job_actions",
}
tables = [
    table
    for name, table in Base.metadata.tables.items()
    if name.startswith("studio_") and name not in legacy
]
dialect = postgresql.dialect()
statements: list[str] = []
for table, constraints in sort_tables_and_constraints(tables):
    if table is None:
        statements.extend(
            str(AddConstraint(constraint).compile(dialect=dialect)) for constraint in constraints
        )
    else:
        statements.append(
            str(
                CreateTable(table, include_foreign_key_constraints=constraints).compile(
                    dialect=dialect
                )
            )
        )
        statements.extend(
            str(CreateIndex(index).compile(dialect=dialect))
            for index in sorted(table.indexes, key=lambda item: item.name or "")
        )
target = backend / "migrations/data/studio_foundation_schema.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(
    json.dumps(
        {"tables": [table.name for table in tables], "statements": statements},
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
print(f"Frozen {len(tables)} foundation tables")

projection = (
    '"""随基础迁移冻结的转换函数，禁止导入运行时业务模块。"""\n\nfrom typing import Any\nfrom uuid import NAMESPACE_URL, uuid5\n\nDocument = Any\n\n\n'
    + inspect.getsource(stable_id)
    + "\n\n"
    + inspect.getsource(project_rows)
)
(target.parent / "studio_foundation_rows.py").write_text(projection, encoding="utf-8")
