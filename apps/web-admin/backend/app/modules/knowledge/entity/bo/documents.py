"""可追溯的资料分段；所有位置均来自原文件，不由语言模型猜测。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ParsedDocument:
    """提取正文、内容类型及具备页码或行列坐标的分段。"""

    media_type: str
    segments: list[dict[str, object]]

    @property
    def text(self) -> str:
        """预览与索引使用同一提取结果。"""
        return "\n".join(str(item["content"]) for item in self.segments)
