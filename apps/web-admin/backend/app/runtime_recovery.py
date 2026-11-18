"""服务端 Agent 栅栏运维命令：默认检查，人工核实退出后才允许显式释放。"""

import argparse
import asyncio
import json
import sys

from pydantic import ValidationError

from app.infrastructure.configuration import Settings
from app.infrastructure.database import Database
from app.infrastructure.event_loop import create_event_loop
from app.integrations.dsh.protocol import Fields, RuntimeFailure
from app.modules.runtime.service.recovery_service import RuntimeRecoveryService


def parse_arguments(arguments: list[str] | None = None) -> argparse.Namespace:
    """在连接数据库前校验显式恢复参数，不把缺少确认退化为默认删除。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True, help="待检查的用户 ID")
    parser.add_argument("--release", action="store_true", help="显式释放已核实退出的旧栅栏")
    parser.add_argument("--expected-generation", help="只读检查返回的旧 generation")
    parser.add_argument("--expected-machine", help="只读检查返回的旧 machine，原样传入")
    parser.add_argument("--expected-pid", help="只读检查返回的旧 PID；未记录时传 none")
    parser.add_argument(
        "--confirm-executor-exited",
        action="store_true",
        help="运维已在旧机器/容器核实整个旧执行者退出；本参数不会代为核实",
    )
    args = parser.parse_args(arguments)
    expected = [args.expected_generation, args.expected_machine, args.expected_pid]
    if args.release:
        if not all(expected) or not args.confirm_executor_exited:
            parser.error("--release 必须同时提供完整 expected 快照及 --confirm-executor-exited")
        if args.expected_pid != "none":
            try:
                if int(args.expected_pid) <= 0:
                    raise ValueError
            except ValueError:
                parser.error("--expected-pid 必须为正整数或 none")
    elif any(expected) or args.confirm_executor_exited:
        parser.error("expected 快照与退出确认只允许和 --release 一起使用")
    return args


async def run(args: argparse.Namespace) -> Fields:
    """只装配数据库与恢复服务，不运行迁移、API、监督器或模型调用。"""
    settings = Settings()
    database = Database(settings.database_url)
    try:
        service = RuntimeRecoveryService(database)
        if args.release:
            return await service.release(
                args.owner,
                generation=args.expected_generation,
                machine=args.expected_machine,
                pid=None if args.expected_pid == "none" else int(args.expected_pid),
                confirmed_exited=args.confirm_executor_exited,
            )
        return await service.inspect(args.owner)
    finally:
        await database.close()


def main(arguments: list[str] | None = None) -> None:
    """部署管理员入口；失败输出稳定错误，不泄漏数据库 URL、凭据或驱动堆栈。"""
    args = parse_arguments(arguments)
    try:
        with asyncio.Runner(loop_factory=create_event_loop) as runner:
            result = runner.run(run(args))
    except RuntimeFailure as error:
        result = {"error": error.code, "detail": str(error)}
    except ValidationError:
        result = {"error": "runtime_recovery_configuration_invalid", "detail": "部署配置校验失败"}
    except Exception:
        result = {
            "error": "runtime_recovery_failed",
            "detail": "恢复检查或提交失败；请重新只读检查，不推断原操作成功",
        }
    print(
        json.dumps(result, ensure_ascii=False), file=sys.stderr if "error" in result else sys.stdout
    )
    if "error" in result:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
