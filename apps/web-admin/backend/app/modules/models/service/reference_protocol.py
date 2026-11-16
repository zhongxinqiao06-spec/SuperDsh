"""公共视觉与联网协议；只解释供应商结构化结果，不把生成文本当检索证据。"""

import base64
import io
import json
from typing import cast
from urllib.parse import urlsplit

from PIL import Image, UnidentifiedImageError

from app.infrastructure.errors import DomainError


def object_value(value: object) -> dict[str, object]:
    """内部协议对象转换，不接受字符串 JSON 隐式展开。"""
    return cast(dict[str, object], value) if isinstance(value, dict) else {}


def checked_prompt(value: str) -> str:
    """限制单次参考资料请求，避免不受控的大段内容进入供应商。"""
    if not value.strip() or len(value) > 12000 or "\x00" in value:
        raise DomainError(422, "请输入不超过 12000 字的分析或查询要求")
    return value.strip()


def encode_images(images: list[tuple[bytes, str]], maximum: int) -> list[str]:
    """校验已授权文件的真实图片格式和像素，拒绝伪造 MIME 与超大压缩图片。"""
    if not 1 <= len(images) <= maximum:
        raise DomainError(422, "请选择参考图片，数量不能超过模型配置上限")
    formats = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
    encoded = []
    for content, mime in images:
        if mime not in formats or not content or len(content) > 20 * 1024 * 1024:
            raise DomainError(422, "参考图片必须为 20MB 以内的 PNG、JPEG 或 WebP")
        try:
            with Image.open(io.BytesIO(content)) as image:
                if image.format != formats[mime] or image.width * image.height > 40_000_000:
                    raise DomainError(422, "参考图片格式或像素范围无效")
                image.verify()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
            raise DomainError(422, "参考图片无法解码") from error
        encoded.append(f"data:{mime};base64," + base64.b64encode(content).decode())
    return encoded


def vision_request(
    adapter: str, model: str, parameters: dict[str, object], prompt: str, images: list[str]
) -> tuple[str, dict[str, object]]:
    """办公和创作共用同一视觉请求构造，不接收任意供应商参数。"""
    prompt = checked_prompt(prompt)
    if not images or len(images) > int(cast(int, parameters.get("maxImages", 4))):
        raise DomainError(422, "视觉理解需要已授权图片，且不能超过配置上限")
    body: dict[str, object]
    if adapter in {"volcengine-ark", "openai-responses"}:
        endpoint = "/responses"
        body = {
            "model": model,
            "store": False,
            "max_output_tokens": parameters.get("maxTokens", 4096),
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        *[{"type": "input_image", "image_url": value} for value in images],
                    ],
                }
            ],
        }
        if adapter == "volcengine-ark" and parameters.get("thinking") in {"enabled", "disabled"}:
            body["thinking"] = {"type": parameters["thinking"]}
    elif adapter == "openai-completions":
        endpoint = "/chat/completions"
        body = {
            "model": model,
            "max_tokens": parameters.get("maxTokens", 4096),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        *[{"type": "image_url", "image_url": {"url": value}} for value in images],
                    ],
                }
            ],
        }
    else:
        raise DomainError(422, "当前连接不支持视觉理解")
    bounded_body(body)
    return endpoint, body


def search_request(
    adapter: str, model: str, parameters: dict[str, object], query: str
) -> tuple[str, dict[str, object]]:
    """联网协议由配置显式声明；只开放真实搜索，不添加未经支持的扩展参数。"""
    query = checked_prompt(query)
    prompt = (
        "请实际检索公开网页后回答，保留供应商返回的引用来源；不能以已有知识冒充检索。\n" + query
    )
    body: dict[str, object]
    if parameters.get("protocol", "responses") == "responses":
        body = {
            "model": model,
            "store": False,
            "max_output_tokens": parameters.get("maxTokens", 4096),
            "input": [{"role": "user", "content": prompt}],
            "tools": [{"type": "web_search"}],
            "stream": True,
        }
        endpoint = "/responses"
    else:
        body = {
            "model": model,
            "max_tokens": parameters.get("maxTokens", 4096),
            "messages": [{"role": "user", "content": prompt}],
        }
        if adapter == "volcengine-ark":
            body["tools"] = [{"type": "web_search"}]
        else:
            # 百炼 OpenAI Chat 不支持 DashScope 的 enable_source / enable_citation。
            body.update({"enable_search": True, "search_options": {"forced_search": True}})
        endpoint = "/chat/completions"
    bounded_body(body)
    return endpoint, body


def bounded_body(body: dict[str, object]) -> None:
    """将编码后的图片开销计入整个请求大小上限。"""
    if len(json.dumps(body, ensure_ascii=False).encode()) > 32 * 1024 * 1024:
        raise DomainError(413, "模型输入超过处理上限")


def vision_answer(value: dict[str, object]) -> str:
    """只有正常结束的可见正文才算完成，推理文本不能冒充回答。"""
    choices = value.get("choices")
    first = object_value(choices[0]) if isinstance(choices, list) and choices else {}
    if value.get("status") == "incomplete" or first.get("finish_reason") == "length":
        raise DomainError(
            502, "分析达到输出上限或未完整结束；未自动重试", "vision_response_incomplete"
        )
    if value.get("status") in {"failed", "cancelled", "queued", "in_progress"} or value.get(
        "error"
    ):
        raise DomainError(502, "供应商未完成分析；未自动重试收费调用")
    output = value.get("output")
    answer = ""
    if isinstance(output, list):
        texts: list[str] = []
        for raw in output:
            item = object_value(raw)
            if item.get("type") != "message":
                continue
            content = item.get("content")
            if isinstance(content, list):
                texts.extend(
                    str(part["text"])
                    for part in content
                    if isinstance(part, dict)
                    and part.get("type") == "output_text"
                    and isinstance(part.get("text"), str)
                )
        answer = "\n".join(texts)
    else:
        message = object_value(first.get("message"))
        if isinstance(message.get("content"), str):
            answer = str(message["content"])
    if not answer.strip() or len(answer) > 512 * 1024:
        raise DomainError(502, "分析服务未返回有效正文或正文过大")
    return answer


def research_answer(value: dict[str, object]) -> dict[str, object]:
    """引用仅取结构化 annotations / 搜索调用结果，忽略正文里的任意 URL。"""
    answer = vision_answer(value)
    sources: dict[str, dict[str, str]] = {}

    def add(raw: object) -> None:
        item = object_value(raw)
        citation = object_value(item.get("url_citation")) or item
        url = citation.get("url")
        if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 32 for c in url):
            return
        try:
            parsed = urlsplit(url)
        except ValueError:
            return
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            return
        title = citation.get("title")
        sources[url] = {
            "title": title[:500] if isinstance(title, str) and title.strip() else parsed.hostname,
            "url": url,
        }

    def annotations(raw: object) -> None:
        if isinstance(raw, list):
            for item in raw:
                if object_value(item).get("type") == "url_citation":
                    add(item)

    output = value.get("output")
    if isinstance(output, list):
        for raw in output:
            item = object_value(raw)
            if item.get("type") == "web_search_call" and item.get("status") == "completed":
                entries = object_value(item.get("action")).get("sources")
                if isinstance(entries, list):
                    for entry in entries:
                        add(entry)
            if item.get("type") == "message":
                content = item.get("content")
                if isinstance(content, list):
                    for part in content:
                        if object_value(part).get("type") == "output_text":
                            annotations(object_value(part).get("annotations"))
    choices = value.get("choices")
    if isinstance(choices, list) and choices:
        annotations(object_value(object_value(choices[0]).get("message")).get("annotations"))
    # 原生或兼容服务只有明确返回搜索结果字段时，才接受该协议来源。
    search_info = object_value(value.get("search_info")) or object_value(
        object_value(output).get("search_info")
    )
    entries = search_info.get("search_results")
    if isinstance(entries, list):
        for entry in entries:
            add(entry)
    if not sources:
        raise DomainError(
            502,
            "供应商未返回可核验的检索来源，请调整联网配置；未自动重试",
            "research_sources_missing",
        )
    return {"text": answer, "sources": list(sources.values())[:50]}
