"""已授权位图的真实解码验证，拒绝外链、SVG脚本与解压炸弹。"""

import io

from PIL import Image, UnidentifiedImageError

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import InputFile


def image_data(file: InputFile) -> tuple[bytes, int, int]:
    """统一编码为PNG并移除无关元数据，尺寸与内存均有界。"""
    if not file.content or len(file.content) > 10 * 1024 * 1024:
        raise DomainError(413, "图片大小超过10MiB")
    try:
        with Image.open(io.BytesIO(file.content)) as source:
            if (
                source.format not in {"PNG", "JPEG", "WEBP"}
                or source.width * source.height > 40_000_000
                or max(source.size) > 10000
            ):
                raise DomainError(422, "图片格式或尺寸不受支持")
            source.load()
            output = io.BytesIO()
            source.convert("RGBA").save(output, "PNG")
            if output.tell() > 16 * 1024 * 1024:
                raise DomainError(413, "图片展开后过大")
            return output.getvalue(), source.width, source.height
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise DomainError(422, "图片无法解码") from error
