"""办公工具的有界数据合同，路径只能由可信调用适配器生成。"""

import hashlib
import io
import math
import re
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from app.infrastructure.errors import DomainError

Cell = str | float | int | bool | None


@dataclass(frozen=True)
class InputFile:
    """授权后的内存文件，不接收外部URL或任意本机路径。"""

    filename: str
    content: bytes
    identifier: str = ""

    @property
    def sha256(self) -> str:
        """真实输入摘要用于准备与生成之间的内容栅栏。"""
        return hashlib.sha256(self.content).hexdigest()


@dataclass(frozen=True)
class Artifact:
    """可编辑成果及结构证据，质量评估由实际渲染完成。"""

    filename: str
    content: bytes
    media_type: str
    structure: dict[str, object]
    metadata: dict[str, object]


def record(value: object, label: str, allowed: set[str] | None = None) -> dict[str, object]:
    """拒绝非对象和未知命令字段，避免将脚本混入结构化方案。"""
    if (
        not isinstance(value, dict)
        or any(not isinstance(key, str) for key in value)
        or (allowed is not None and not set(value).issubset(allowed))
    ):
        raise DomainError(422, label + "包含未知字段或格式错误")
    return dict(value)


def text(value: object, label: str, maximum: int = 200, empty: bool = False) -> str:
    """普通文字长度有界，控制字符不进入XML或公式。"""
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or (not empty and not value.strip())
        or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", value)
    ):
        raise DomainError(422, label + "不能为空或超过长度限制")
    return value.strip()


def sequence(value: object, label: str, maximum: int = 100, minimum: int = 0) -> list[object]:
    """所有模型提供的列表均限制长度。"""
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise DomainError(422, label + "数量无效")
    return list(value)


def numeric(value: object, label: str) -> float:
    """只接受有限数字，布尔值不视作数值。"""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or abs(value) > 1e15
    ):
        raise DomainError(422, label + "必须是有限数值")
    return float(value)


def color(value: object, default: str = "214D66") -> str:
    """颜色采用Office兼容六位十六进制值。"""
    if value is None:
        return default
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{6}", value):
        raise DomainError(422, "主题色必须为六位十六进制颜色")
    return value.upper()


def safe_filename(value: object, suffix: str) -> str:
    """输出文件名不允许目录跳转或系统路径。"""
    name = text(value, "文件名", 200)
    if (
        re.search(r'[\\/:*?"<>|\x00-\x1f]', name)
        or name in {".", ".."}
        or name.endswith((".", " "))
        or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.I)
    ):
        raise DomainError(422, "文件名不能包含路径")
    return name if name.lower().endswith(suffix) else name + suffix


def office_archive(
    file: InputFile, _budget: list[int] | None = None, _depth: int = 0
) -> dict[str, bytes]:
    """先限额展开并检查XML/关系，阻止宏、外链、嵌入执行对象和压缩炸弹。"""
    if not file.content or len(file.content) > 10 * 1024 * 1024:
        raise DomainError(413, "Office输入文件最多10MiB")
    if _depth > 1:
        raise DomainError(422, "Office嵌入层级不受支持")
    budget = _budget if _budget is not None else [0, 0]
    expected = {
        ".docx": "word/document.xml",
        ".xlsx": "xl/workbook.xml",
        ".pptx": "ppt/presentation.xml",
    }.get(PurePosixPath(file.filename).suffix.lower())
    if expected is None:
        raise DomainError(422, "请选择DOCX、XLSX或PPTX文件")
    result: dict[str, bytes] = {}
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(file.content)) as archive:
            budget[0] += len(archive.infolist())
            if budget[0] > 1000:
                raise DomainError(413, "Office与嵌入文档总条目过多")
            if not 1 <= len(archive.infolist()) <= 600:
                raise DomainError(413, "Office文档条目过多")
            seen: set[str] = set()
            for item in archive.infolist():
                path = PurePosixPath(item.filename)
                if (
                    path.is_absolute()
                    or ".." in path.parts
                    or "\\" in item.filename
                    or ":" in item.filename
                    or item.filename.lower() in seen
                    or item.flag_bits & 1
                    or (item.external_attr >> 16) & 0o170000 == 0o120000
                ):
                    raise DomainError(422, "Office归档存在非法路径或加密条目")
                seen.add(item.filename.lower())
                if item.is_dir():
                    continue
                if item.file_size > 8 * 1024 * 1024 or total + item.file_size > 40 * 1024 * 1024:
                    raise DomainError(413, "Office文档展开大小超限")
                with archive.open(item) as source:
                    data = source.read(8 * 1024 * 1024 + 1)
                total += len(data)
                budget[1] += len(data)
                if (
                    len(data) != item.file_size
                    or len(data) > 8 * 1024 * 1024
                    or total > 40 * 1024 * 1024
                    or budget[1] > 40 * 1024 * 1024
                ):
                    raise DomainError(413, "Office文档内容超限")
                lower = item.filename.lower()
                if any(
                    term in lower
                    for term in ("vbaproject", "activex/", "oleobject", "externallinks/")
                ):
                    raise DomainError(422, "Office文件包含宏、活动对象或外部链接")
                if lower.endswith((".xml", ".rels")):
                    node = ElementTree.fromstring(
                        data, forbid_dtd=True, forbid_entities=True, forbid_external=True
                    )
                    if lower.endswith(".rels") and any(
                        child.attrib.get("TargetMode") == "External"
                        and not child.attrib.get("Type", "").endswith("/hyperlink")
                        for child in node
                    ):
                        raise DomainError(422, "Office外部数据或图片链接不受支持")
                    if lower.endswith(".rels") and any(
                        child.attrib.get("Type", "").rsplit("/", 1)[-1]
                        in {"oleObject", "control", "vbaProject", "externalLink"}
                        for child in node
                    ):
                        raise DomainError(422, "Office包含活动对象关系")
                if "/embeddings/" in lower:
                    if not lower.endswith(".xlsx"):
                        raise DomainError(422, "只支持原生图表的嵌入工作簿")
                    # 图表工作簿共用总展开预算，不能借嵌套ZIP绕过宏/外链和大小检查。
                    office_archive(InputFile(item.filename, data), budget, _depth + 1)
                result[item.filename] = data
    except (
        zipfile.BadZipFile,
        ValueError,
        RuntimeError,
        ElementTree.ParseError,
        DefusedXmlException,
    ) as error:
        raise DomainError(422, "Office文档已损坏或包含不支持内容") from error
    if expected not in result:
        raise DomainError(422, "Office文件内容与扩展名不匹配")
    return result
