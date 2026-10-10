"""Exercise the fixed worker template without touching a Docker daemon or user data."""

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location(
    "agent_supervisor", Path(__file__).parents[1] / "agent-supervisor/supervisor.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DockerFixture:
    def __init__(self):
        self.calls = []
        self.networks = {}
        self.volumes = {}
        self.container = None
        self.image_id = "sha256:fixture"
        self.api_containers = [
            {
                "Id": "api",
                "Labels": {
                    "com.docker.compose.project": "temporary",
                    "com.docker.compose.service": "server-next",
                },
            }
        ]

    async def request(self, method, path, **options):
        self.calls.append((method, path, options))
        body = options.get("json", {})
        if path.startswith("/images/"):
            return {"Id": self.image_id}
        if path == "/containers/json":
            return self.api_containers
        if path == "/networks/create":
            self.networks[body["Name"]] = {**body, "Containers": {}}
            return {"Id": body["Name"]}
        if path.startswith("/networks/"):
            parts = path.split("/")
            if method == "GET":
                return self.networks.get(parts[2])
            self.networks[parts[2]]["Containers"][body["Container"]] = {}
            return {}
        if path == "/volumes/create":
            self.volumes[body["Name"]] = body
            return body
        if path.startswith("/volumes/"):
            return self.volumes.get(path.split("/")[2])
        if path == "/containers/create":
            self.container = {
                "Id": "worker",
                "Image": self.image_id,
                "Config": body,
                "State": {"Running": False},
            }
            return {"Id": "worker"}
        if path.endswith("/json"):
            return self.container
        if path.endswith("/start"):
            self.container["State"]["Running"] = True
        elif path.endswith("/stop"):
            self.container["State"]["Running"] = False
        elif method == "DELETE":
            self.container = None
        return {}


def fixture():
    docker = DockerFixture()
    supervisor = module.AgentSupervisor(
        docker,
        project="temporary",
        image="fixture:local",
        server_url="http://server-next:8000",
    )
    request = module.AgentRequest(
        ownerUserId="usr_test",
        connectorId="conn_server_test",
        connectorToken="temporary-token",
        serverUrl="http://server-next:8000",
    )
    return docker, supervisor, request


def test_template_isolates_worker_and_idempotency_preserves_volumes():
    async def check():
        docker, supervisor, request = fixture()
        assert (await supervisor.prepare(request))["status"] == "starting"
        template = docker.container["Config"]
        host = template["HostConfig"]
        assert template["User"] == "1000:1000"
        assert host["ReadonlyRootfs"] and host["CapDrop"] == ["ALL"]
        assert host["SecurityOpt"] == ["no-new-privileges:true"]
        assert "noexec" in host["Tmpfs"]["/tmp"].split(",")
        assert {mount["Target"] for mount in host["Mounts"]} == {
            "/data",
            "/workspace",
        }
        assert all(mount["Type"] == "volume" for mount in host["Mounts"])
        assert all(
            "SECRET" not in value
            and "DB_URL" not in value
            and "ENCRYPTION" not in value
            for value in template["Env"]
        )
        assert host["NetworkMode"].endswith("-network")
        assert (await supervisor.prepare(request))["status"] == "running"
        next(iter(docker.networks.values()))["Containers"]["worker"] = {}
        assert (await supervisor.prepare(request))["status"] == "running"
        assert sum(path == "/containers/create" for _, path, _ in docker.calls) == 1
        assert len(docker.volumes) == 2
        await supervisor.stop(request.ownerUserId)
        assert len(docker.volumes) == 2
        assert not any(
            method == "DELETE" and path.startswith("/volumes")
            for method, path, _ in docker.calls
        )

    asyncio.run(check())


def test_image_digest_change_replaces_container_but_preserves_data():
    async def check():
        docker, supervisor, request = fixture()
        await supervisor.prepare(request)
        original_volumes = dict(docker.volumes)
        docker.image_id = "sha256:updated"
        await supervisor.prepare(request)
        assert sum(path == "/containers/create" for _, path, _ in docker.calls) == 2
        assert docker.volumes == original_volumes

    asyncio.run(check())


def test_cannot_select_image_host_origin_or_alien_resource():
    async def check():
        docker, supervisor, request = fixture()
        request.serverUrl = "http://attacker.test"
        with pytest.raises(HTTPException) as rejected:
            await supervisor.prepare(request)
        assert rejected.value.status_code == 422
        request.serverUrl = "http://server-next:8000"
        name, _ = supervisor.identity(request.ownerUserId)
        docker.volumes[f"{name}-data"] = {"Labels": {}}
        with pytest.raises(HTTPException) as rejected:
            await supervisor.prepare(request)
        assert rejected.value.status_code == 409
        assert docker.container is None

    asyncio.run(check())


def test_only_internal_supervisor_secret_can_prepare(monkeypatch):
    _, supervisor, request = fixture()
    monkeypatch.setenv("SUPERDSH_AGENT_SUPERVISOR_SECRET", "temporary-internal-secret")
    with TestClient(module.create_app(supervisor)) as client:
        assert client.post("/agents", json=request.model_dump()).status_code == 401
        response = client.post(
            "/agents",
            json={**request.model_dump(), "image": "untrusted"},
            headers={"Authorization": "Bearer temporary-internal-secret"},
        )
        assert response.status_code == 422
        assert (
            client.post(
                "/agents",
                json=request.model_dump(),
                headers={"Authorization": "Bearer temporary-internal-secret"},
            ).status_code
            == 200
        )


@pytest.mark.parametrize("api_service", ["server-next", "agent-api-relay"])
def test_platform_service_remains_scoped_to_project_and_worker_network(api_service):
    async def check():
        docker, _, request = fixture()
        docker.api_containers[0]["Labels"]["com.docker.compose.service"] = api_service
        supervisor = module.AgentSupervisor(
            docker,
            project="temporary",
            image="fixture:local",
            server_url="http://server-next:8000",
            api_service=api_service,
        )
        await supervisor.prepare(request)
        query = next(
            options for _, path, options in docker.calls if path == "/containers/json"
        )
        assert json.loads(query["params"]["filters"])["label"] == [
            "com.docker.compose.project=temporary",
            f"com.docker.compose.service={api_service}",
        ]
        connection = next(
            options["json"]
            for _, path, options in docker.calls
            if path.endswith("/connect")
        )
        assert connection == {
            "Container": "api",
            "EndpointConfig": {"Aliases": ["server-next"]},
        }
        assert set(next(iter(docker.networks.values()))["Containers"]) == {"api"}
        assert (
            "SUPERDSH_AGENT_SERVER_URL=http://server-next:8000"
            in (docker.container["Config"]["Env"])
        )

    asyncio.run(check())


def test_native_api_support_does_not_allow_arbitrary_docker_services():
    with pytest.raises(ValueError, match="Invalid platform API service"):
        module.AgentSupervisor(
            DockerFixture(),
            project="temporary",
            image="fixture:local",
            server_url="http://server-next:8000",
            api_service="postgres",
        )


@pytest.mark.parametrize(
    "label,value",
    [
        ("com.docker.compose.project", "another-project"),
        ("com.docker.compose.service", "postgres"),
    ],
)
def test_api_container_labels_are_verified_before_joining_network(label, value):
    async def check():
        docker, supervisor, request = fixture()
        docker.api_containers[0]["Labels"][label] = value
        with pytest.raises(HTTPException) as rejected:
            await supervisor.prepare(request)
        assert rejected.value.status_code == 409
        assert not docker.networks
        assert docker.container is None

    asyncio.run(check())


def test_missing_api_does_not_create_worker_or_volumes():
    async def check():
        docker, supervisor, request = fixture()
        docker.api_containers = []
        with pytest.raises(HTTPException) as rejected:
            await supervisor.prepare(request)
        assert rejected.value.status_code == 503
        assert not docker.networks
        assert not docker.volumes
        assert docker.container is None

    asyncio.run(check())


def test_unrelated_network_members_cannot_gain_access_to_user_runtime():
    async def check():
        docker, supervisor, request = fixture()
        name, labels = supervisor.identity(request.ownerUserId)
        docker.networks[f"{name}-network"] = {
            "Labels": labels,
            "Containers": {"another-users-worker": {}},
        }
        with pytest.raises(HTTPException) as rejected:
            await supervisor.prepare(request)
        assert rejected.value.status_code == 409
        assert docker.container is None
        assert not any(path.endswith("/connect") for _, path, _ in docker.calls)

    asyncio.run(check())
