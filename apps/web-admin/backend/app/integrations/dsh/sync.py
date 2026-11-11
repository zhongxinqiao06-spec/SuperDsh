"""RuntimeBridge 单流投影消费，持久化成功之前不确认批次。"""

from __future__ import annotations

import asyncio
import json

from app.modules.runtime.service.ports import ProjectionSink

from .bridge import RuntimeBridge
from .protocol import Fields, RuntimeFailure, fields


class ProjectionSync:
    """验证批次和快照顺序；出错断开等待显式恢复，不跳过坏事件。"""

    def __init__(self, bridge: RuntimeBridge, store: ProjectionSink, owner: str) -> None:
        self.bridge, self.store, self.owner = bridge, store, owner
        self.ready = asyncio.Event()
        self.stream: str | None = None
        self.expected = 1
        self._snapshot: Fields | None = None
        self._ids: set[str] = set()
        self._bytes = 0
        self.task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """初始化订阅；initial inventory 持久提交并 ACK 后才报告 Connector 就绪。"""
        result = fields(
            await self.bridge.request(
                "runtime.sync.subscribe",
                {"checkpointVersion": self.bridge.metadata["checkpointVersion"]},
            )
        )
        if result.get("projectionVersion") != self.bridge.metadata[
            "projectionVersion"
        ] or not isinstance(result.get("streamId"), str):
            raise RuntimeFailure("runtime_projection_mismatch", "运行时投影不兼容")
        self.stream = str(result["streamId"])
        self.task = asyncio.create_task(self._consume())

    async def _consume(self) -> None:
        try:
            while True:
                message = await self.bridge.notifications.get()
                if message.get("method") == "runtime.error":
                    raise RuntimeFailure("runtime_projection_error", "运行时投影失败，请重试准备")
                if message.get("method") != "runtime.sync.batch":
                    continue
                batch = fields(message.get("params"))
                if batch.get("streamId") != self.stream:
                    continue
                if batch.get("batchSeq") != self.expected:
                    raise RuntimeFailure("runtime_projection_order", "运行时投影顺序错误")
                healthy = self._validate(batch)
                acknowledgement = await self.store.commit(self.owner, batch)
                await self.bridge.request("runtime.sync.ack", acknowledgement)
                self.expected += 1
                if healthy:
                    self.ready.set()
        except Exception:
            await self.bridge.close()
            raise

    def _validate(self, batch: Fields) -> bool:
        operations = batch.get("operations")
        if not isinstance(operations, list):
            raise RuntimeFailure("invalid_projection", "运行时投影缺少操作")
        healthy = False
        for raw in operations:
            op = fields(raw)
            kind = op.get("kind")
            if kind == "snapshot.begin":
                if self._snapshot is not None:
                    raise RuntimeFailure("invalid_snapshot", "重复开始投影快照")
                self._snapshot, self._ids, self._bytes = op, set(), 0
            elif kind in {"snapshot.items", "snapshot.commit", "snapshot.abort"}:
                snapshot = self._snapshot
                if (
                    snapshot is None
                    or op.get("snapshotId") != snapshot.get("snapshotId")
                    or op.get("sessionId") != snapshot.get("sessionId")
                ):
                    raise RuntimeFailure("invalid_snapshot", "投影快照身份不一致")
                if kind == "snapshot.items":
                    items = op.get("items")
                    if not isinstance(items, list):
                        raise RuntimeFailure("invalid_snapshot", "快照内容无效")
                    for raw_item in items:
                        item = fields(raw_item)
                        identifier = item.get("id")
                        if (
                            not isinstance(identifier, str)
                            or identifier in self._ids
                            or item.get("sessionId") != op.get("sessionId")
                        ):
                            raise RuntimeFailure("invalid_snapshot", "快照含重复或其他会话事件")
                        self._ids.add(identifier)
                        self._bytes += len(json.dumps(item).encode())
                        if self._bytes > 256 * 1024 * 1024:
                            raise RuntimeFailure("snapshot_too_large", "投影快照超过大小限制")
                else:
                    if kind == "snapshot.commit" and (
                        len(self._ids) != op.get("totalItems")
                        or op.get("throughSeq") != snapshot.get("throughSeq")
                    ):
                        raise RuntimeFailure("invalid_snapshot", "投影快照不完整")
                    self._snapshot = None
                    self._ids.clear()
            elif (
                isinstance(kind, str)
                and kind.startswith("checkpoint.")
                and self._snapshot is not None
            ):
                raise RuntimeFailure("invalid_checkpoint", "快照尚未完成不能提交 checkpoint")
            elif kind == "notifications":
                events = op.get("notifications")
                if not isinstance(events, list):
                    raise RuntimeFailure("invalid_projection", "通知列表无效")
                for raw_event in events:
                    event = fields(raw_event)
                    params = fields(event.get("params"))
                    if event.get("method") == "timeline.itemUpsert" and fields(
                        params.get("item")
                    ).get("sessionId") != params.get("sessionId"):
                        raise RuntimeFailure("invalid_projection", "时间线包含其他会话内容")
                    healthy |= (
                        event.get("method") == "session.inventory.complete"
                        and params.get("complete") is True
                    )
        return healthy

    async def close(self) -> None:
        """结束消费后不再持久化或 ACK 迟到批次。"""
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
