"""产品自带的可编辑示例资料；只在用户显式初始化时按声明生成，不参与普通执行。"""

import base64
import csv
import io
import zipfile
from datetime import date, timedelta
from typing import cast
from xml.etree import ElementTree

from app.modules.agents.entity.vo.agent_vo import AssetInput
from app.workers.processes import ProcessWorkers
from toolkits.office.contracts import record, sequence, text


def _stable_archive(content: bytes) -> bytes:
    """固定 ZIP 元数据以保持并发/中断后的资料摘要稳定，不把生成时间当内容变更。"""
    source, output = io.BytesIO(content), io.BytesIO()
    with (
        zipfile.ZipFile(source) as archive,
        zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as result,
    ):
        for name in sorted(archive.namelist()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            content = archive.read(name)
            if name == "docProps/core.xml":
                node = ElementTree.fromstring(content)
                for field in node:
                    if field.tag.split("}")[-1] in {"created", "modified"}:
                        field.text = "2000-01-01T00:00:00Z"
                content = ElementTree.tostring(node, encoding="utf-8", xml_declaration=True)
            result.writestr(info, content)
    return output.getvalue()


def generate(payload: dict[str, object], directory: str) -> dict[str, object]:
    """受管工作进程生成资料；合成记录与模板内容来自产品 JSON，不读取用户数据。"""
    # 原生数值和 Office 库仅在工作进程导入，平台装配不承担其加载或初始化。
    from toolkits.office.presentation import create_presentation
    from toolkits.office.spreadsheet import create_workbook

    result: dict[str, object] = {}
    for raw in sequence(payload.get("assets"), "示例资料", 20):
        item = record(raw, "资料声明")
        format_name = item.get("format")
        if format_name == "text":
            content = text(item.get("content"), "示例文字", 20000).encode()
        elif format_name == "sales":
            stream = io.StringIO(newline="")
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(
                ["orderId", "date", "region", "product", "quantity", "unitPrice", "unitCost"]
            )
            products = [
                record(value, "商品") for value in sequence(item.get("products"), "商品", 20, 1)
            ]
            regions = sequence(item.get("regions"), "地区", 20, 1)
            start = date.fromisoformat(str(item["date"]))
            count = int(cast(int, item.get("count", 100)))
            if not 1 <= count <= 1000:
                raise ValueError("示例行数无效")
            for index in range(count):
                product = products[index % len(products)]
                writer.writerow(
                    [
                        f"XH-DEMO-{index + 1:04d}",
                        (start + timedelta(days=index % 30)).isoformat(),
                        regions[index % len(regions)],
                        product["name"],
                        2 + index % 19,
                        product["price"],
                        product["cost"],
                    ]
                )
            content = stream.getvalue().encode()
        elif format_name == "xlsx":
            content = _stable_archive(
                create_workbook(record(item.get("plan"), "模板方案"), []).content
            )
        elif format_name == "pptx":
            content = _stable_archive(
                create_presentation(record(item.get("plan"), "模板方案")).content
            )
        else:
            raise ValueError("未知示例资料格式")
        result[str(item["key"])] = {
            "name": item["name"],
            "kind": item["kind"],
            "contentBase64": base64.b64encode(content).decode(),
        }
    return result


async def prepare(workers: ProcessWorkers, package: dict[str, object]) -> dict[str, AssetInput]:
    """对工作进程返回值重新做边界校验，CPU 渲染不阻塞 API 事件循环。"""
    result = await workers.submit(generate, package, 60)
    return {key: AssetInput.model_validate(value) for key, value in result.items()}
