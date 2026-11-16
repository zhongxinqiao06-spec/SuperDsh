"""正文范围基于原始修订重定位；重复文字不能靠全文搜索替换。"""

from difflib import SequenceMatcher

from app.infrastructure.errors import DomainError


def relocate(base: str, current: str, start: int, end: int) -> tuple[int, int]:
    """只接受完整保留的目标区间；区间内发生手工修改时拒绝覆盖。"""
    if not 0 <= start < end <= len(base):
        raise DomainError(422, "请选择有效的剧本正文")
    if base == current:
        return start, end
    fragment = base[start:end]
    if base.count(fragment) > 1 or current.count(fragment) > 1:
        raise DomainError(409, "正文包含重复片段且版本已变化，请重新选择，避免修改错误位置")
    for tag, a, b, c, _ in SequenceMatcher(None, base, current).get_opcodes():
        if tag == "equal" and a <= start and end <= b:
            return c + start - a, c + end - a
    raise DomainError(409, "这段正文已被修改，请保留当前内容并重新选择；其他修改不会被覆盖")


def replaced_ranges(scenes: list, start: int, end: int, length: int) -> None:
    """已知替换位置时同步关联范围；完全包含替换的场次保留身份。"""
    delta = length - (end - start)
    for scene in scenes:
        span = scene.scriptRange
        if span is None or span.end <= start:
            continue
        if span.start >= end:
            span.start += delta
            span.end += delta
        elif span.start <= start and end <= span.end:
            span.end += delta
            if span.start == span.end:
                scene.scriptRange = None
        else:
            scene.scriptRange = None
