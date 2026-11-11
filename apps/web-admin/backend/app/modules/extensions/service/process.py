"""外部工具进程的有界输入输出、超时取消和子进程树回收。"""

import asyncio
import json
import os
import signal
import sys
from pathlib import Path

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.validation import package_path


def entrypoint(root: Path, name: str) -> Path:
    """安装入口必须是版本目录内的普通文件，不能借链接执行别处文件。"""
    target = root / package_path(name)
    if (
        not target.resolve().is_relative_to(root.resolve())
        or target.is_symlink()
        or not target.is_file()
    ):
        raise DomainError(422, "扩展入口不存在或越出安装目录")
    return target


def tool_environment(directory: Path) -> dict[str, str]:
    """只透传运行系统需要的变量，平台密钥和真实Home不进入工具进程。"""
    inherited = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG"}
    }
    return {
        **inherited,
        "HOME": str(directory),
        "USERPROFILE": str(directory),
        "TEMP": str(directory),
        "TMP": str(directory),
        "TMPDIR": str(directory),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


async def stop_process(process: asyncio.subprocess.Process) -> None:
    """只有本次创建的进程可回收，Windows回收整个工具子树。"""
    if process.returncode is not None:
        return
    if sys.platform == "win32":
        killer = await asyncio.create_subprocess_exec(
            "taskkill.exe",
            "/PID",
            str(process.pid),
            "/T",
            "/F",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=0x08000000,
        )
        await killer.wait()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    await process.wait()


async def run_process(
    command: list[str],
    directory: Path,
    payload: dict[str, object] | None = None,
    duration: float = 120,
    environment: dict[str, str] | None = None,
) -> dict[str, object]:
    """受管调用不经shell，错误不回传可能含凭据的stderr。"""
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=directory,
            env=environment or tool_environment(directory),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=os.name != "nt",
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
    except OSError as error:
        raise DomainError(503, "扩展进程无法启动，请检查运行环境和安装完整性") from error

    async def collect() -> bytes:
        assert process.stdout is not None
        chunks: list[bytes] = []
        size = 0
        while chunk := await process.stdout.read(65536):
            size += len(chunk)
            if size > 32 * 1024 * 1024:
                raise DomainError(413, "工具返回内容过大")
            chunks.append(chunk)
        return b"".join(chunks)

    try:
        async with asyncio.timeout(duration):
            assert process.stdin is not None
            if payload is not None:
                raw = json.dumps(payload, ensure_ascii=False).encode()
                if len(raw) > 16 * 1024 * 1024:
                    raise DomainError(413, "工具输入过大")
                process.stdin.write(raw)
                await process.stdin.drain()
            process.stdin.close()
            output = await collect()
            if await process.wait() != 0:
                raise DomainError(502, "扩展工具执行失败，请检查包内诊断")
            if payload is None:
                return {"ok": True}
            value = json.loads(output)
            if not isinstance(value, dict):
                raise ValueError("invalid tool result")
            return value
    except TimeoutError as error:
        raise DomainError(504, "扩展工具执行超时") from error
    except (ValueError, UnicodeError) as error:
        raise DomainError(502, "扩展必须返回单个JSON对象") from error
    finally:
        await stop_process(process)


def runtime_command(installation: Path, manifest: dict[str, object], node: str) -> list[str]:
    """Python扩展使用安装期准备的解释器，不复用旧平台或任意系统包。"""
    executable = node
    if manifest.get("runtime") == "python":
        executable = str(
            installation / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        )
        if not Path(executable).is_file():
            raise DomainError(503, "扩展Python环境缺失，请重新安装该版本")
        # CreateProcess 对解释器路径仍可能应用 MAX_PATH；扩展前缀支持合法的深层安装目录。
        if os.name == "nt" and not executable.startswith("\\\\?\\"):
            executable = (
                ("\\\\?\\UNC\\" + executable[2:])
                if executable.startswith("\\\\")
                else "\\\\?\\" + executable
            )
    return [executable, str(entrypoint(installation, str(manifest["entrypoint"])))]
