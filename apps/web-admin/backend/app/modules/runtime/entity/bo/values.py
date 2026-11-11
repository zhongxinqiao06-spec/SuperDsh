"""运行领域共享 JSON 值类型，不包含任何传输实现。"""

type Json = None | bool | int | float | str | list[Json] | dict[str, Json]
type Fields = dict[str, Json]
