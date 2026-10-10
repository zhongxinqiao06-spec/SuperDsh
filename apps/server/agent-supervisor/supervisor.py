"""Own the Docker control socket; execution containers receive only scoped credentials."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
from contextlib import asynccontextmanager
from urllib.parse import quote

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

OWNER_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MANAGED_LABEL = "com.superdsh.managed-agent"
PROJECT_LABEL = "com.superdsh.project"
OWNER_LABEL = "com.superdsh.owner"
API_SERVICES = {"server-next", "agent-api-relay"}


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ownerUserId: str
    connectorId: str = Field(min_length=1, max_length=128)
    connectorToken: str = Field(min_length=1, max_length=4096)
    runtimeId: str = "dsh"
    serverUrl: str


class DockerControl:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(
            base_url="http://docker/v1.45",
            transport=httpx.AsyncHTTPTransport(uds="/var/run/docker.sock"),
            timeout=60,
        )

    async def request(self, method: str, path: str, **options):
        response = await self.client.request(method, path, **options)
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            # Docker errors may contain a container's environment. Never relay them.
            raise HTTPException(503, "Agent container operation failed")
        return response.json() if response.content else {}

    async def close(self) -> None:
        await self.client.aclose()


class AgentSupervisor:
    def __init__(
        self,
        docker: DockerControl,
        *,
        project: str,
        image: str,
        server_url: str,
        api_service: str = "server-next",
    ) -> None:
        if not OWNER_PATTERN.fullmatch(project):
            raise ValueError("Invalid managed project name")
        if api_service not in API_SERVICES:
            raise ValueError("Invalid platform API service")
        self.docker = docker
        self.project = project
        self.image = image
        self.server_url = server_url.rstrip("/")
        self.api_service = api_service
        self.locks: dict[str, asyncio.Lock] = {}

    def identity(self, owner: str) -> tuple[str, dict[str, str]]:
        if not OWNER_PATTERN.fullmatch(owner):
            raise HTTPException(422, "Invalid owner identity")
        digest = hashlib.sha256(owner.encode()).hexdigest()[:24]
        return f"{self.project}-agent-{digest}", {
            MANAGED_LABEL: "true",
            PROJECT_LABEL: self.project,
            OWNER_LABEL: owner,
        }

    def check_labels(self, resource: dict, labels: dict[str, str]) -> None:
        actual = (
            resource.get("Labels") or resource.get("Config", {}).get("Labels") or {}
        )
        if any(actual.get(key) != value for key, value in labels.items()):
            raise HTTPException(409, "Agent resource ownership mismatch")

    async def inspect(self, owner: str):
        name, labels = self.identity(owner)
        container = await self.docker.request("GET", f"/containers/{quote(name)}/json")
        if container is None:
            return {"status": "stopped", "containerId": None}
        self.check_labels(container, labels)
        state = container.get("State", {})
        status = "running" if state.get("Running") else "stopped"
        if state.get("Health", {}).get("Status") == "unhealthy":
            status = "error"
        return {"status": status, "containerId": container["Id"]}

    async def api_containers(self) -> list[dict]:
        labels = {
            "com.docker.compose.project": self.project,
            "com.docker.compose.service": self.api_service,
        }
        filters = {"label": [f"{key}={value}" for key, value in labels.items()]}
        containers = await self.docker.request(
            "GET", "/containers/json", params={"filters": json.dumps(filters)}
        )
        if not containers:
            raise HTTPException(503, "Platform API container is unavailable")
        for container in containers:
            self.check_labels(container, labels)
        return containers

    async def ensure_network(self, name: str, labels: dict[str, str]) -> None:
        api_containers = await self.api_containers()
        network_name = f"{name}-network"
        network = await self.docker.request("GET", f"/networks/{quote(network_name)}")
        if network is None:
            await self.docker.request(
                "POST",
                "/networks/create",
                json={
                    "Name": network_name,
                    "Driver": "bridge",
                    "Labels": labels,
                },
            )
            network = await self.docker.request(
                "GET", f"/networks/{quote(network_name)}"
            )
        self.check_labels(network, labels)
        connected = network.get("Containers", {})
        allowed = {api["Id"] for api in api_containers}
        worker = await self.docker.request("GET", f"/containers/{quote(name)}/json")
        if worker is not None:
            self.check_labels(worker, labels)
            allowed.add(worker["Id"])
        if set(connected) - allowed:
            raise HTTPException(409, "Agent network contains an unrelated container")
        for api in api_containers:
            if api["Id"] not in connected:
                await self.docker.request(
                    "POST",
                    f"/networks/{quote(network_name)}/connect",
                    json={
                        "Container": api["Id"],
                        "EndpointConfig": {"Aliases": ["server-next"]},
                    },
                )

    async def prepare(self, payload: AgentRequest):
        name, labels = self.identity(payload.ownerUserId)
        if (
            payload.runtimeId != "dsh"
            or payload.serverUrl.rstrip("/") != self.server_url
        ):
            raise HTTPException(422, "Agent runtime configuration is not permitted")
        async with self.locks.setdefault(name, asyncio.Lock()):
            image = await self.docker.request(
                "GET", f"/images/{quote(self.image, safe='')}/json"
            )
            if not image:
                raise HTTPException(
                    503,
                    "Agent runtime image is not installed; build the server images first",
                )
            await self.ensure_network(name, labels)
            mounts = []
            for suffix, target in (("data", "/data"), ("workspace", "/workspace")):
                volume_name = f"{name}-{suffix}"
                volume = await self.docker.request(
                    "GET", f"/volumes/{quote(volume_name)}"
                )
                if volume is None:
                    volume = await self.docker.request(
                        "POST",
                        "/volumes/create",
                        json={"Name": volume_name, "Labels": labels},
                    )
                self.check_labels(volume, labels)
                mounts.append(
                    {"Type": "volume", "Source": volume_name, "Target": target}
                )
            container = await self.docker.request(
                "GET", f"/containers/{quote(name)}/json"
            )
            if container:
                self.check_labels(container, labels)
                expected = [
                    f"SUPERDSH_AGENT_CONNECTOR_ID={payload.connectorId}",
                    f"SUPERDSH_AGENT_CONNECTOR_TOKEN={payload.connectorToken}",
                ]
                configuration = container.get("Config", {})
                same = container.get("Image") == image["Id"] and all(
                    value in configuration.get("Env", []) for value in expected
                )
                if same and container.get("State", {}).get("Running"):
                    return {"status": "running", "containerId": container["Id"]}
                if not same:
                    await self.docker.request(
                        "POST", f"/containers/{quote(name)}/stop", params={"t": 20}
                    )
                    await self.docker.request("DELETE", f"/containers/{quote(name)}")
                    container = None
            if container is None:
                created = await self.docker.request(
                    "POST",
                    "/containers/create",
                    params={"name": name},
                    json={
                        "Image": self.image,
                        "User": "1000:1000",
                        "Labels": labels,
                        "Env": [
                            f"SUPERDSH_AGENT_SERVER_URL={self.server_url}",
                            f"SUPERDSH_AGENT_CONNECTOR_ID={payload.connectorId}",
                            f"SUPERDSH_AGENT_CONNECTOR_TOKEN={payload.connectorToken}",
                            "SUPERDSH_AGENT_RUNTIME_ID=dsh",
                            "DSH_HOME=/data/home",
                            "SUPERDSH_AGENT_WORKSPACE=/workspace",
                        ],
                        "HostConfig": {
                            "ReadonlyRootfs": True,
                            "CapDrop": ["ALL"],
                            "SecurityOpt": ["no-new-privileges:true"],
                            "NetworkMode": f"{name}-network",
                            "Mounts": mounts,
                            "Tmpfs": {
                                "/tmp": "rw,nosuid,nodev,noexec,size=268435456,mode=1777"
                            },
                            "PidsLimit": 256,
                            "Memory": 2 * 1024**3,
                            "NanoCpus": 2_000_000_000,
                            "RestartPolicy": {"Name": "unless-stopped"},
                            "LogConfig": {
                                "Type": "json-file",
                                "Config": {"max-size": "10m", "max-file": "3"},
                            },
                        },
                    },
                )
                container_id = created["Id"]
            else:
                container_id = container["Id"]
            await self.docker.request(
                "POST", f"/containers/{quote(container_id)}/start"
            )
            return {"status": "starting", "containerId": container_id}

    async def stop(self, owner: str):
        name, labels = self.identity(owner)
        async with self.locks.setdefault(name, asyncio.Lock()):
            container = await self.docker.request(
                "GET", f"/containers/{quote(name)}/json"
            )
            if container is not None:
                self.check_labels(container, labels)
                if container.get("State", {}).get("Running"):
                    await self.docker.request(
                        "POST", f"/containers/{quote(name)}/stop", params={"t": 20}
                    )
        return {"status": "stopped"}

    async def stop_all(self):
        filters = {
            "label": [f"{MANAGED_LABEL}=true", f"{PROJECT_LABEL}={self.project}"]
        }
        containers = await self.docker.request(
            "GET", "/containers/json", params={"filters": json.dumps(filters)}
        )
        for container in containers or []:
            owner = (container.get("Labels") or {}).get(OWNER_LABEL)
            if owner:
                await self.stop(owner)


def create_app(supervisor: AgentSupervisor | None = None) -> FastAPI:
    control = None
    if supervisor is None:
        control = DockerControl()
        supervisor = AgentSupervisor(
            control,
            project=os.environ.get("SUPERDSH_SERVER_PROJECT", "superdsh-mobile-test"),
            image=os.environ.get(
                "SUPERDSH_AGENT_IMAGE", "superdsh-agent-runtime:local"
            ),
            server_url=os.environ.get(
                "SUPERDSH_AGENT_SERVER_URL", "http://server-next:8000"
            ),
            api_service=os.environ.get("SUPERDSH_AGENT_API_SERVICE", "server-next"),
        )

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            if control:
                try:
                    await supervisor.stop_all()
                finally:
                    await control.close()

    app = FastAPI(title="SuperDsh Agent Supervisor", lifespan=lifespan)

    async def authorize(authorization: str | None = Header(default=None)):
        secret = os.environ.get("SUPERDSH_AGENT_SUPERVISOR_SECRET", "")
        if not secret or not hmac.compare_digest(
            authorization or "", f"Bearer {secret}"
        ):
            raise HTTPException(401, "Supervisor authorization required")

    @app.get("/health")
    async def health():
        return {"status": "ready"}

    @app.get("/agents/{owner}", dependencies=[Depends(authorize)])
    async def inspect(owner: str):
        return await supervisor.inspect(owner)

    @app.post("/agents", dependencies=[Depends(authorize)])
    async def prepare(payload: AgentRequest):
        try:
            return await supervisor.prepare(payload)
        except httpx.HTTPError:
            raise HTTPException(503, "Docker control service is unavailable") from None

    @app.delete("/agents/{owner}", dependencies=[Depends(authorize)])
    async def stop(owner: str):
        return await supervisor.stop(owner)

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=8090, access_log=False)
