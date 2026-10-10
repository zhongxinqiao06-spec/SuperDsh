"""One complete Node Host plus its pinned Python Connector, owned by this container."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import signal
from pathlib import Path

from connector.core.config import ConnectorConfig
from connector.core.runtime_owner import RuntimeLease
from connector.logging import configure_connector_logging
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.dsh.provider import DshProvider
from connector.server.client import BackendRpcClient
from gateway import ModelGateway


class ServerDshProvider(DshProvider):
    async def validate_config(self, values):
        expected = Path(os.environ["DSH_HOME"]).resolve()
        if Path(values.get("dshHome") or expected).resolve() != expected:
            raise RuntimeInvalidRequestError("Runtime must use its owned Harness Home")
        return await super().validate_config({**values, "dshHome": str(expected)})

    async def create_runtime(self, config, host):
        if host.instance.runtime_id != "dsh":
            raise RuntimeInvalidRequestError(
                "Server Agent allows exactly one DSH runtime"
            )
        if (
            Path(config.values.get("dshHome") or "").resolve()
            != Path(os.environ["DSH_HOME"]).resolve()
        ):
            raise RuntimeInvalidRequestError("Runtime must use its owned Harness Home")
        return await super().create_runtime(config, host)


async def main() -> None:
    server_url = os.environ.pop("SUPERDSH_AGENT_SERVER_URL")
    connector_id = os.environ.pop("SUPERDSH_AGENT_CONNECTOR_ID")
    connector_token = os.environ.pop("SUPERDSH_AGENT_CONNECTOR_TOKEN")
    runtime_id = os.environ.pop("SUPERDSH_AGENT_RUNTIME_ID", "dsh")
    if runtime_id != "dsh":
        raise RuntimeError("Server Agent runtime ID must be dsh")
    os.environ["DSH_HOME"] = str(
        Path(os.environ.get("DSH_HOME", "/data/home")).resolve()
    )
    data = Path(os.environ.get("AGENT_CONNECTOR_DATA_DIR", "/data/connector")).resolve()
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    workspace = Path(os.environ.get("SUPERDSH_AGENT_WORKSPACE", "/workspace")).resolve()
    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    config = ConnectorConfig(
        server_url=server_url,
        connector_id=connector_id,
        connector_token=connector_token,
        state_path=str(data / "sync-state.json"),
    )
    client = BackendRpcClient(config, agent_runtime_providers=(ServerDshProvider(),))
    host_ready = False
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    lease = RuntimeLease(
        data / "runtime.json", kind="superdsh-server-agent", legacy_paths=[]
    )
    lease.claim()
    gateway = ModelGateway(
        server_url=server_url,
        secret=secrets.token_urlsafe(48),
        access_token=client.ensure_access_token,
        ready=lambda: host_ready and client._rpc.connected,
    )
    host = None
    tasks: list[asyncio.Task] = []
    try:
        await gateway.start()
        environment = dict(os.environ)
        environment["SUPERDSH_MODEL_GATEWAY"] = json.dumps(
            {
                "origin": f"http://127.0.0.1:{gateway.port}",
                "secret": gateway.secret,
            }
        )
        host = await asyncio.create_subprocess_exec(
            "node",
            str(Path(__file__).with_name("host.mjs")),
            env=environment,
            cwd=workspace,
            stdout=asyncio.subprocess.PIPE,
        )

        async def watch_host() -> None:
            nonlocal host_ready
            assert host is not None and host.stdout is not None
            while line := await host.stdout.readline():
                if line.rstrip() == b"SUPERDSH_AGENT_HOST_READY":
                    host_ready = True
                else:
                    print(line.decode(errors="replace").rstrip(), flush=True)
            code = await host.wait()
            if not stop.is_set():
                raise RuntimeError(f"Harness process stopped ({code})")

        async def connect() -> None:
            while not host_ready:
                if host is not None and host.returncode is not None:
                    raise RuntimeError("Harness startup failed")
                await asyncio.sleep(0.2)
            await client.run_forever()

        tasks = [
            asyncio.create_task(watch_host()),
            asyncio.create_task(connect()),
            asyncio.create_task(stop.wait()),
        ]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            await task
    finally:
        stop.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await gateway.close()
        if host is not None and host.returncode is None:
            host.terminate()
            try:
                await asyncio.wait_for(host.wait(), 10)
            except TimeoutError:
                host.kill()
                await host.wait()
        lease.release()


if __name__ == "__main__":
    configure_connector_logging(debug=False)
    try:
        asyncio.run(main())
    except Exception as error:  # noqa: BLE001 - process boundary must not print credential-bearing exceptions
        # Logs may reach operational administrators; credentials are never diagnostics.
        print(f"Server Agent stopped: {type(error).__name__}", flush=True)
        raise SystemExit(1) from None
