"""隔离浏览器用例的受控 DSH 工具回执；不能用于用户开发库。"""

import asyncio
import os
import sys
from pathlib import Path

from sqlalchemy import select

from app.infrastructure.configuration import Settings
from app.main import create_app
from app.modules.studio.dao.text_edit_dao import TextEditDao
from app.modules.studio.entity.do.models import StudioProject

ROOT = Path(__file__).resolve().parents[4]


async def main() -> None:
    settings = Settings()
    if "web_admin_test" not in settings.database_url or not str(
        settings.data_dir.resolve()
    ).startswith(str(ROOT / ".superdsh-work/web-admin-validation")):
        raise RuntimeError("只允许隔离测试环境")
    app = create_app(settings)
    # 隔离 HTTP 服务已持有 runtime 租约；这里只使用服务契约提交受控回执，不启动第二个监督器。
    try:
        account = await app.state.services.identity.authenticate(
            os.environ["SCRIPT_EDIT_TEST_TOKEN"]
        )
        async with app.state.services.studio.database.sessions() as session:
            project = await session.scalar(
                select(StudioProject).where(StudioProject.id == sys.argv[1])
            )
            sid = await TextEditDao(session).conversation(sys.argv[1])
            if not project or not sid:
                raise RuntimeError("隔离作品缺少会话")
        result = await app.state.services.extensions.execute(
            account,
            {
                "sourceId": "starbridge.text-edit",
                "toolId": "studio_text_suggest",
                "version": app.state.services.extensions.builtins["starbridge.text-edit"][
                    "version"
                ],
            },
            {"editId": sys.argv[2], "replacement": "噜噜说：海风真舒服，我们一起去看海。"},
            {},
            {"sessionId": sid, "receiptId": "browser-" + sys.argv[2]},
        )
        print(result["structuredContent"]["state"])
    finally:
        await app.state.database.close()


if __name__ == "__main__":
    asyncio.run(main())
