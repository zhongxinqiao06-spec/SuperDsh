"""终端规范视图与设备原始协议结果并存；原始字段不作为JSON字段泄入规范响应。"""


class TerminalResult(dict[str, object]):
    """调用方按字典使用规范结果，入口适配器可选取同一次执行的原始协议结果。"""

    def __init__(self, payload: dict[str, object], protocol_result: dict[str, object]) -> None:
        super().__init__(payload)
        self.protocol_result = protocol_result
