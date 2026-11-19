"""隔离浏览器中的合成模型 SSE；真实 DSH、建议工具、权限与数据库保持生产路径。"""

import json
import re
from collections.abc import AsyncIterator

from fastapi import FastAPI

import app.main as application
from app.infrastructure.configuration import Settings
from app.integrations.dsh.protocol import Fields, fields
from app.launcher import main
from app.modules.studio.entity.do.series_do import SeriesProposal
from fixtures.dsh_models import ControlledModels
from fixtures.studio_browser_media import isolated_media

isolated_media()
original = application.create_app


def create_app(settings: Settings | None = None) -> FastAPI:
    app = original(settings)
    model = ControlledModels()

    async def stream(owner: str, path: str, body: Fields) -> AsyncIterator[bytes]:
        messages = json.dumps(body.get("messages", []), ensure_ascii=False)
        yield model._chunk({"role": "assistant"})
        if "Create a concise title for an AI coding-assistant session" in messages:
            # 固定 DSH 的辅助标题调用没有工具，主编排调用仍必须命中下方 schema。
            yield model._chunk({"content": "短剧分集编排"})
            yield model._chunk({}, "stop")
        elif '"role": "tool"' in messages:
            yield model._chunk({"content": "建议已保存，请逐段对比采用。"})
            yield model._chunk({}, "stop")
        else:
            match = re.search(r"proposalId=([a-zA-Z0-9_-]+)", messages)
            if not match:
                raise ValueError("隔离模型仅接受带范围的短剧请求")
            async with app.state.database.sessions() as session:
                proposal = await session.get(SeriesProposal, match.group(1))
                if proposal is None:
                    raise ValueError("缺少本轮建议记录")
                arguments = {
                    "proposalId": proposal.id,
                    "episodes": [
                        {
                            "episodeId": item["episodeId"],
                            "story": {
                                **item["story"],
                                "synopsis": item["story"].get("synopsis", "") + "月光照亮新线索。",
                                "ending": "旅伴发现下一段旅程的线索，约定天亮后共同出发。",
                            },
                        }
                        for item in proposal.original
                    ],
                }
            tools = body.get("tools", [])
            candidates = (
                [fields(fields(tool).get("function")) for tool in tools]
                if isinstance(tools, list)
                else []
            )
            target = next(
                (
                    tool
                    for tool in candidates
                    if "proposalId" in fields(fields(tool.get("parameters")).get("properties"))
                ),
                None,
            )
            if target is None:
                raise ValueError("主编排请求缺少真实绑定的短剧建议工具")
            yield model._chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "series-ui-suggestion",
                            "type": "function",
                            "function": {
                                "name": target["name"],
                                "arguments": json.dumps(arguments, ensure_ascii=False),
                            },
                        }
                    ]
                }
            )
            yield model._chunk({}, "tool_calls")
        yield b"data: [DONE]\n\n"

    app.state.services.model_proxy.stream = stream
    return app


if __name__ == "__main__":
    application.create_app = create_app
    main()
