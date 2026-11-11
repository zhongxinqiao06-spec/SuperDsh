"""框架无关的稳定业务错误，接口层负责输出协议结构。"""


class DomainError(Exception):
    """保留旧 detail/code 语义；不在异常中携带凭据或服务器路径。"""

    def __init__(self, status: int, detail: str, code: str | None = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code = code
