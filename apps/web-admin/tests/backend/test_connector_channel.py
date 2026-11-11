"""真实Connector通道用例配合合成WebSocket端口，验证撤权、背压与重连代际。"""

import asyncio
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect

from app.infrastructure.errors import DomainError
from app.modules.devices.service.connector_channel import Connection, ConnectorChannel


def transport() -> Mock:
    """仅替换网络传输，通道的授权时机、锁、Future和清理运行真实实现。"""
    socket = Mock(spec=WebSocket)
    socket.accept = AsyncMock()
    socket.close = AsyncMock()
    socket.send_json = AsyncMock()
    socket.receive_json = AsyncMock()
    return socket


async def test_revocation_while_receiving_prevents_next_notification() -> None:
    """帧到达前发生撤权，即便接收等待开始时有权限，也不得写入一次通知。"""
    channel, socket = ConnectorChannel(), transport()
    receiving, deliver = asyncio.Event(), asyncio.Event()
    permitted = True

    async def authorize() -> object:
        if not permitted:
            raise DomainError(403, "permission revoked")
        return {}

    async def receive() -> object:
        receiving.set()
        await deliver.wait()
        return {"method": "session.created", "params": {"sessionId": "synthetic"}}

    socket.receive_json.side_effect = receive
    notify = AsyncMock()
    task = asyncio.create_task(
        channel.serve("connector", cast(WebSocket, socket), notify, authorize)
    )
    try:
        await asyncio.wait_for(receiving.wait(), 2)
        permitted = False
        deliver.set()
        await asyncio.wait_for(task, 2)
        notify.assert_not_awaited()
        socket.close.assert_awaited_once()
        assert not channel.connections
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_send_backpressure_is_bounded_and_releases_pending_future() -> None:
    """写网络阻塞也计入同一RPC期限，失败后不遗留请求Future或写锁。"""
    channel, socket = ConnectorChannel(), transport()
    sending, stalled = asyncio.Event(), asyncio.Event()

    async def send(_frame: object) -> None:
        sending.set()
        await stalled.wait()

    socket.send_json.side_effect = send
    connection = Connection(cast(WebSocket, socket))
    channel.connections["connector"] = connection
    task = asyncio.create_task(channel.call("connector", "synthetic.call", {}, timeout_seconds=0.1))
    try:
        await asyncio.wait_for(sending.wait(), 2)
        pending = next(iter(connection.pending.values()))
        with pytest.raises(DomainError) as failure:
            await asyncio.wait_for(task, 2)
        assert failure.value.status == 504
        assert pending.cancelled()
        assert not connection.pending
        assert not connection.writer.locked()
        assert channel.connections["connector"] is connection
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await channel.close()


async def test_writer_contention_is_bounded_before_network_send() -> None:
    """排队等待写锁同样受总期限限制，不能无限占用64个在途请求名额。"""
    channel, socket = ConnectorChannel(), transport()
    connection = Connection(cast(WebSocket, socket))
    channel.connections["connector"] = connection
    await connection.writer.acquire()
    try:
        with pytest.raises(DomainError) as failure:
            await channel.call("connector", "synthetic.call", {}, timeout_seconds=0.02)
        assert failure.value.status == 504
        socket.send_json.assert_not_awaited()
        assert not connection.pending
        assert connection.writer.locked()
    finally:
        connection.writer.release()
        await channel.close()


async def test_old_receive_loop_cannot_remove_replacement_connection() -> None:
    """旧连接关闭回调迟到时，只能回收旧代际，不能断开已经接管的新连接。"""
    channel = ConnectorChannel()
    old, new = transport(), transport()
    old_receiving, new_receiving, release_old = asyncio.Event(), asyncio.Event(), asyncio.Event()
    wait_new = asyncio.Event()

    async def old_receive() -> object:
        old_receiving.set()
        await release_old.wait()
        raise WebSocketDisconnect()

    async def new_receive() -> object:
        new_receiving.set()
        await wait_new.wait()
        raise WebSocketDisconnect()

    old.receive_json.side_effect = old_receive
    new.receive_json.side_effect = new_receive
    notify, authorize = AsyncMock(), AsyncMock(return_value={})
    tasks: list[asyncio.Task[None]] = []
    try:
        tasks.append(
            asyncio.create_task(channel.serve("connector", cast(WebSocket, old), notify, authorize))
        )
        await asyncio.wait_for(old_receiving.wait(), 2)
        tasks.append(
            asyncio.create_task(channel.serve("connector", cast(WebSocket, new), notify, authorize))
        )
        await asyncio.wait_for(new_receiving.wait(), 2)
        replacement = channel.connections["connector"]
        assert replacement.socket is new
        release_old.set()
        await asyncio.wait_for(tasks[0], 2)
        assert channel.connections["connector"] is replacement
        old.close.assert_awaited_once()
        new.close.assert_not_awaited()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await channel.close()
    new.close.assert_awaited_once()
    assert not channel.connections
