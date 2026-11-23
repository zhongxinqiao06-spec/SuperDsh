"""部署终端专用入口：核验 CLI 会话后原子替换，只保留查询用量必需的字段。"""

import asyncio
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from app.infrastructure.errors import DomainError
from app.modules.models.service.aliyun_personal_usage import verified_cli_session
from app.modules.models.service.provider_transport import ProviderTransport


async def install(directory: Path, profile: dict, transport: ProviderTransport) -> None:
    """先核对部署绑定和百炼返回的身份；验证期间或验证失败时保留现有会话。"""
    config = directory / "aliyun-token-plan.json"
    original = config.read_bytes()
    settings = json.loads(original)
    if settings.get("edition") != "personal":
        raise ValueError("当前部署未绑定个人订阅")
    binding = settings["cliRamAccount"]
    uid, owner = binding["userId"], binding["ownerId"]
    if uid == owner or not all(
        isinstance(v, str) and v.isascii() and v.isdigit() and len(v) <= 32 for v in (uid, owner)
    ):
        raise ValueError("RAM 账号绑定无效")
    session = {
        k: profile[k]
        for k in ("access_token", "console_region", "console_site", "console_switch_agent")
        if k in profile
    }
    with TemporaryDirectory(dir=directory) as temporary:
        pending = Path(temporary) / "aliyun-personal-cli"
        pending.mkdir(mode=0o700)
        source = pending / "config.json"
        source.write_text(json.dumps(session), encoding="utf-8")
        source.chmod(0o600)
        async with asyncio.timeout(25):
            await verified_cli_session(transport, Path(temporary), uid, owner)
        if config.read_bytes() != original:
            raise ValueError("RAM 绑定已变更，请重新授权")
        target = directory / pending.name
        target.mkdir(mode=0o700, exist_ok=True)
        os.replace(source, target / source.name)


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024 or not isinstance(profile := json.loads(raw), dict):
            raise ValueError()
        asyncio.run(install(Path("/data/config"), profile, ProviderTransport()))
    except DomainError as error:
        sys.exit(error.detail)
    except (KeyError, ValueError, OSError, TimeoutError):
        sys.exit("部署绑定、CLI 配置或核验请求异常，本次授权未安装。")
    print("RAM 账号核验成功。请返回管理页刷新用量。")
