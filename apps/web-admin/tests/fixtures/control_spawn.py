"""父控制管道保持打开时，真实 NumPy 子进程必须能完成初始化和任务。"""

import json
import multiprocessing
import sys
from multiprocessing.connection import Connection
from threading import Event, Thread

from app.infrastructure.control_channel import control_lines


def calculate(payload: str, output: Connection) -> None:
    """导入原生库并返回结果，长参数覆盖 Windows spawn 的启动管道写入。"""
    import numpy as np

    output.send((len(payload), int(np.asarray([1, 2, 3]).sum())))
    output.close()


def main() -> None:
    """同时验证控制消息分包、父管道 EOF 与工作进程退出。"""
    stopped, monitoring = Event(), Event()

    def monitor() -> None:
        monitoring.set()
        for line in control_lines(sys.stdin, stopped):
            if json.loads(line).get("command") == "shutdown":
                break
        stopped.set()

    thread = Thread(target=monitor, daemon=True)
    thread.start()
    monitoring.wait()
    context = multiprocessing.get_context("spawn")
    receiving, sending = context.Pipe(duplex=False)
    process = context.Process(target=calculate, args=("x" * 65536, sending))
    try:
        process.start()
        sending.close()
        assert receiving.poll(10), "工作进程未能在控制管道打开时启动"
        assert receiving.recv() == (65536, 6)
        process.join(5)
        assert process.exitcode == 0
        print("SPAWN_OK", flush=True)
        assert stopped.wait(10), "父控制消息没有被接收"
    finally:
        stopped.set()
        if process.pid is not None and process.is_alive():
            process.kill()
            process.join(5)
        receiving.close()
        sending.close()
        thread.join(1)


if __name__ == "__main__":
    main()
