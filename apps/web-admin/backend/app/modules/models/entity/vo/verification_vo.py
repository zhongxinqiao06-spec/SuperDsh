"""只读模型检测结果；目录可访问不代表具体模型已经完成生成验证。"""

from typing import Literal

from pydantic import BaseModel


class ModelVerification(BaseModel):
    """未确认状态必须保留 ok=False，避免客户端把目录缺失误认为凭据有效。"""

    ok: bool
    status: Literal["verified", "unverified"]
    message: str
    serverTime: str
