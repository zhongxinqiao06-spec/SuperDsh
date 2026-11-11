"""真实资料解析，保留 PDF 页、Office 段落/工作表/幻灯片和文本行号。"""

import asyncio
import csv
import io
import multiprocessing
import zipfile
from multiprocessing.connection import Connection
from pathlib import PurePath

from defusedxml import ElementTree

from app.infrastructure.errors import DomainError
from app.modules.knowledge.entity.bo.documents import ParsedDocument

MAX_TEXT = 2_000_000


def _parse_worker(name: str, content: bytes, allow_empty: bool, pipe: Connection) -> None:
    try:
        pipe.send(parse_document(name, content, allow_empty))
    except DomainError as error:
        pipe.send({"status": error.status, "detail": error.detail})
    except Exception:
        pipe.send({"status": 422, "detail": "文档解析失败"})
    finally:
        pipe.close()


async def parse_document_async(
    name: str, content: bytes, allow_empty: bool = False
) -> ParsedDocument:
    """不可信格式在受管子进程解析；超时或请求取消时回收解析进程。"""
    context = multiprocessing.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(
        target=_parse_worker, args=(name, content, allow_empty, child), daemon=True
    )
    try:
        process.start()
    except OSError as error:
        parent.close()
        child.close()
        raise DomainError(503, "无法启动文档解析进程") from error
    child.close()
    try:
        result = await asyncio.wait_for(asyncio.to_thread(parent.recv), 30)
        if isinstance(result, ParsedDocument):
            return result
        if isinstance(result, dict):
            raise DomainError(int(result["status"]), str(result["detail"]))
        raise DomainError(503, "文档解析进程返回无效结果")
    except TimeoutError as error:
        raise DomainError(504, "资料解析超时，请拆分后重试") from error
    except (EOFError, OSError) as error:
        raise DomainError(503, "文档解析进程提前退出") from error
    finally:
        if process.is_alive():
            process.terminate()
        await asyncio.to_thread(process.join, 5)
        if process.is_alive():
            process.kill()
            await asyncio.to_thread(process.join, 5)
        parent.close()


def parse_document(name: str, content: bytes, allow_empty: bool = False) -> ParsedDocument:
    """只接受有解析能力的文档；压缩包先检查展开大小，禁止宏和外部实体。"""
    suffix = PurePath(name).suffix.lower()
    segments: list[dict[str, object]] = []
    consumed = 0

    def append(text: str, location: dict[str, object]) -> None:
        nonlocal consumed
        text = text.strip().replace("\x00", "")
        if not text:
            return
        consumed += len(text)
        if consumed > MAX_TEXT or len(segments) >= 100000:
            raise DomainError(413, "文档正文超出解析上限，请拆分后上传")
        # 段落分块保留同一真实位置，避免向量输入溢出；不把不同页拼成一个来源。
        for offset in range(0, len(text), 1200):
            segments.append({"content": text[offset : offset + 1200], "location": dict(location)})

    try:
        if suffix in {".txt", ".md", ".markdown", ".csv", ".json", ".log"}:
            try:
                text = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = content.decode("gb18030")
            if suffix == ".csv":
                for number, row in enumerate(csv.reader(io.StringIO(text)), 1):
                    append(" | ".join(row), {"row": number, "line": number})
            else:
                heading = ""
                for number, line in enumerate(text.splitlines(), 1):
                    if suffix in {".md", ".markdown"} and line.lstrip().startswith("#"):
                        heading = line.lstrip("# ").strip()
                    append(line, {"line": number, **({"heading": heading} if heading else {})})
            media = (
                "text/csv"
                if suffix == ".csv"
                else "application/json"
                if suffix == ".json"
                else "text/plain"
            )
        elif suffix == ".pdf":
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(content))
            if reader.is_encrypted or len(reader.pages) > 500:
                raise DomainError(422, "暂不支持加密或超过 500 页的 PDF")
            for number, page in enumerate(reader.pages, 1):
                append(page.extract_text() or "", {"page": number})
            media = "application/pdf"
        elif suffix in {".docx", ".pptx", ".xlsx"}:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                entries = archive.infolist()
                if (
                    len(entries) > 10000
                    or sum(item.file_size for item in entries) > 64 * 1024 * 1024
                    or any(item.file_size > 16 * 1024 * 1024 for item in entries)
                ):
                    raise DomainError(413, "Office 文件解压大小超出限制")
                if any(item.filename.lower().endswith("vbaproject.bin") for item in entries):
                    raise DomainError(422, "不允许含宏的资料")
                names = {item.filename for item in entries}
                if suffix == ".docx":
                    if "word/document.xml" not in names:
                        raise DomainError(422, "文件内容不是有效 Word 文档")
                    root = ElementTree.fromstring(archive.read("word/document.xml"))
                    for number, paragraph in enumerate(
                        root.iter(
                            "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"
                        ),
                        1,
                    ):
                        append(
                            "".join(
                                node.text or ""
                                for node in paragraph.iter(
                                    "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"
                                )
                            ),
                            {"paragraph": number},
                        )
                    media = (
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    )
                elif suffix == ".pptx":
                    slide_names = sorted(
                        (
                            value
                            for value in names
                            if value.startswith("ppt/slides/slide")
                            and value.endswith(".xml")
                            and value[16:-4].isdigit()
                        ),
                        key=lambda value: int(value[16:-4]),
                    )
                    if not slide_names:
                        raise DomainError(422, "文件内容不是有效 PowerPoint 文档")
                    for number, filename in enumerate(slide_names, 1):
                        root = ElementTree.fromstring(archive.read(filename))
                        append(
                            "\n".join(
                                node.text or ""
                                for node in root.iter(
                                    "{http://schemas.openxmlformats.org/drawingml/2006/main}t"
                                )
                            ),
                            {"page": number},
                        )
                    media = (
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    )
                else:
                    from openpyxl import load_workbook

                    book = load_workbook(
                        io.BytesIO(content), read_only=True, data_only=True, keep_links=False
                    )
                    try:
                        for sheet in book.worksheets:
                            if (
                                sheet.max_row
                                and sheet.max_row > 100000
                                or sheet.max_column
                                and sheet.max_column > 1000
                            ):
                                raise DomainError(413, "工作表行列超出解析上限")
                            for number, cells in enumerate(sheet.iter_rows(values_only=True), 1):
                                append(
                                    " | ".join("" if cell is None else str(cell) for cell in cells),
                                    {"sheet": sheet.title, "row": number},
                                )
                    finally:
                        book.close()
                    media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            raise DomainError(422, "仅支持 TXT、Markdown、CSV、JSON、PDF、DOCX、PPTX 和 XLSX")
    except DomainError:
        raise
    except Exception as error:
        raise DomainError(422, "文件损坏、编码不受支持或无法安全解析") from error
    if not segments and not allow_empty:
        raise DomainError(422, "文件未提取到正文；扫描 PDF 请先完成 OCR")
    return ParsedDocument(media, segments)
