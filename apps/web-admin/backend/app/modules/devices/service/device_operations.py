"""设备文件、Shell 和 Relay 用例装配，生命周期由平台唯一所有者控制。"""

from typing import TYPE_CHECKING

from app.infrastructure.database import Database
from app.modules.devices.service.file_transfer_service import FileTransferService
from app.modules.devices.service.shell_service import ShellService
from app.modules.devices.service.terminal_relay_service import TerminalRelayService

if TYPE_CHECKING:
    from app.modules.devices.service.device_service import DeviceService


class DeviceOperations:
    """这里只组合公开领域用例，不新增执行引擎或业务队列。"""

    def __init__(self, devices: "DeviceService", database: Database) -> None:
        self.files = FileTransferService(devices)
        self.shell = ShellService(devices, database)
        self.relay = TerminalRelayService(devices, database)

    async def initialize(self) -> None:
        """启动恢复只收束中断状态，旧副作用请求永不自动执行。"""
        await self.shell.initialize()
        await self.files.initialize()

    async def close(self) -> None:
        """退出先收束命令与进程，再撤销传输票据。"""
        await self.shell.close()
        await self.relay.close()
        await self.files.close()
