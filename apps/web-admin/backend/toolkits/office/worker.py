"""注册给受管工作进程的纯Office操作；路径只由Python服务生成。"""

import hashlib
import json
from pathlib import Path

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import Artifact, InputFile, record, sequence


def _sources(payload: dict[str, object]) -> list[tuple[InputFile, str]]:
    result: list[tuple[InputFile, str]] = []
    root = Path(str(payload["inputRoot"])).resolve()
    for raw in sequence(payload.get("sources", []), "输入", 10):
        source = record(raw, "输入")
        path = Path(str(source["path"]))
        if (
            path.is_symlink()
            or not path.resolve().is_relative_to(root)
            or path.stat().st_size > 10 * 1024 * 1024
        ):
            raise DomainError(422, "受管输入路径或大小无效")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != source["sha256"]:
            raise DomainError(409, "输入内容已变化")
        result.append(
            (InputFile(str(source["name"]), content, str(source["id"])), str(source["role"]))
        )
    return result


def _knowledge(sources: list[tuple[InputFile, str]]) -> dict[str, dict[str, object]]:
    from app.modules.knowledge.service.document_parser import parse_document

    output: dict[str, dict[str, object]] = {}
    for file, role in sources:
        if role in {"input", "knowledge"} and not file.filename.lower().endswith(
            (".png", ".jpg", ".jpeg", ".webp")
        ):
            parsed = parse_document(file.filename, file.content)
            output[file.identifier] = {
                "filename": file.filename,
                "text": parsed.text,
                "sha256": file.sha256,
                "segments": parsed.segments,
            }
    return output


def perform(payload: dict[str, object], directory: str) -> dict[str, object]:
    """动作有固定注册表，不执行用户命令；最终成果保存到受管目录。"""
    # 函数在 ProcessWorkers 子进程执行，重型解析/生成依赖不得由 API 导入链加载。
    from toolkits.office.document import create_document
    from toolkits.office.document_plan import inspect_document
    from toolkits.office.illustration import create_illustration
    from toolkits.office.images import image_data
    from toolkits.office.presentation import create_presentation
    from toolkits.office.presentation_template import inspect_template
    from toolkits.office.spreadsheet import create_workbook
    from toolkits.office.spreadsheet_input import inspect_tables

    sources = _sources(payload)
    implementation, operation = payload["implementation"], payload["operation"]
    template = next((file for file, role in sources if role == "template"), None)
    inputs = [file for file, role in sources if role == "input"]
    images = {file.identifier: file for file, role in sources if role == "image"}
    if operation == "inspect":
        result: dict[str, object] = {}
        result["sources"] = [
            {key: value for key, value in record(raw, "来源").items() if key != "path"}
            for raw in sequence(payload.get("sources", []), "来源", 10)
        ]
        if implementation == "spreadsheet_report":
            result.update(
                inspect_tables(
                    inputs, payload.get("selections"), payload.get("allowValueExtraction") is True
                )
            )
        else:
            knowledge = _knowledge(sources)
            result["documents"] = [
                {
                    "sourceId": identifier,
                    "name": item["filename"],
                    "text": str(item["text"])[:16000],
                    "sha256": item["sha256"],
                }
                for identifier, item in knowledge.items()
            ]
        if template:
            result["template"] = (
                inspect_document(template)
                if implementation == "document_report"
                else inspect_template(template)
                if implementation == "presentation_report"
                else {"name": template.filename, "sha256": template.sha256}
            )
        result["images"] = [
            {
                "imageId": identifier,
                "name": file.filename,
                "width": image_data(file)[1],
                "height": image_data(file)[2],
                "sha256": file.sha256,
            }
            for identifier, file in images.items()
        ]
        return result
    plan = record(payload.get("plan"), "方案")
    artifact: Artifact
    if implementation == "spreadsheet_report":
        artifact = create_workbook(plan, inputs, template)
    elif implementation == "presentation_report":
        artifact = create_presentation(plan, template, images, _knowledge(sources))
    elif implementation == "document_report":
        artifact = create_document(plan, template, sources=_knowledge(sources), images=images)
    elif implementation == "illustration_render":
        artifact = create_illustration(plan)
    else:
        raise DomainError(422, "此实现未注册文档渲染动作")
    normalized = artifact.metadata.get("plan", artifact.structure)
    if operation == "prepare":
        return {
            "plan": normalized,
            "filename": artifact.filename,
            "mediaType": artifact.media_type,
            "structure": artifact.structure,
            "metadata": artifact.metadata,
        }
    if operation != "execute":
        raise DomainError(422, "Office工作进程动作无效")
    output = Path(str(payload["outputRoot"])).resolve()
    if not output.is_dir() or output.is_symlink():
        raise DomainError(422, "成果目录无效")
    (output / artifact.filename).write_bytes(artifact.content)
    metadata: dict[str, object] = {
        "filename": artifact.filename,
        "mediaType": artifact.media_type,
        "structure": artifact.structure,
        "metadata": artifact.metadata,
        "sha256": hashlib.sha256(artifact.content).hexdigest(),
    }
    (output / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False), encoding="utf-8"
    )
    return metadata
