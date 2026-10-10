from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gateway import ModelGateway


class ModelGatewayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.token_count = 0
        self.scope = "a" * 64

        async def token():
            self.token_count += 1
            return "connector-access-token"

        async def upstream(request):
            self.requests.append(request)
            if request.url.path.endswith("/catalog"):
                return httpx.Response(
                    200,
                    json={
                        "scope": self.scope,
                        "default": {"providerId": "personal_1", "modelId": "test"},
                        "providers": [
                            {
                                "providerId": "personal_1",
                                "protocol": "openai-completions",
                                "source": "personal",
                                "name": "My model",
                                "models": [],
                            }
                        ],
                    },
                )
            return httpx.Response(
                200,
                content=b'data: {"content":"ok"}\n\ndata: [DONE]\n\n',
                headers={"Content-Type": "text/event-stream"},
            )

        self.gateway = ModelGateway(
            server_url="http://platform.test",
            secret="local-capability",
            access_token=token,
            ready=lambda: False,
            port=0,
        )
        await self.gateway.client.aclose()
        self.gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        await self.gateway.start()
        self.client = httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{self.gateway.port}",
            headers={"Authorization": "Bearer local-capability"},
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.gateway.close()

    async def test_health_is_not_ready_without_real_host_and_connector(self):
        result = await self.client.get("/health")
        self.assertEqual(result.status_code, 503)
        self.assertEqual(result.json(), {"ready": False})
        self.assertEqual(self.token_count, 0)

    async def test_loopback_capability_required_before_connector_authentication(self):
        result = await self.client.get(
            "/catalog", headers={"Authorization": "Bearer wrong"}
        )
        self.assertEqual(result.status_code, 401)
        self.assertEqual(self.token_count, 0)
        self.assertEqual(self.requests, [])

    async def test_catalog_and_stream_use_connector_token_and_fixed_origin(self):
        catalog = (await self.client.get("/catalog")).json()
        self.assertEqual(catalog["default"]["providerId"], "personal_1")
        route = f"/scopes/{self.scope}/providers/personal_1/openai-completions/chat/completions"
        response = await self.client.post(route, json={"model": "test", "stream": True})
        self.assertEqual(response.status_code, 200)
        self.assertIn("data: [DONE]", response.text)
        request = self.requests[-1]
        self.assertEqual(
            str(request.url),
            "http://platform.test/api/v2/connector/models/personal_1/openai-completions/chat/completions",
        )
        self.assertEqual(
            request.headers["authorization"], "Bearer connector-access-token"
        )
        self.assertNotIn("local-capability", response.text)

    async def test_wrong_scope_and_protocol_operation_do_not_reach_upstream(self):
        await self.client.get("/catalog")
        for route in (
            f"/scopes/{'b' * 64}/providers/personal_1/openai-completions/chat/completions",
            f"/scopes/{self.scope}/providers/personal_1/openai-completions/messages",
        ):
            response = await self.client.post(route, json={"model": "test"})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(len(self.requests), 1)

    async def test_three_protocol_authentication_headers_never_reach_upstream(self):
        await self.client.get("/catalog")
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{self.gateway.port}"
        ) as client:
            for protocol, operation, headers in (
                (
                    "openai-completions",
                    "chat/completions",
                    {"Authorization": "Bearer local-capability"},
                ),
                (
                    "openai-responses",
                    "responses",
                    {"Authorization": "Bearer local-capability"},
                ),
                (
                    "anthropic-messages",
                    "messages",
                    {
                        "x-api-key": "local-capability",
                        "anthropic-version": "2023-06-01",
                    },
                ),
                (
                    "anthropic-messages",
                    "v1/messages",
                    {
                        "x-api-key": "local-capability",
                        "anthropic-version": "2023-06-01",
                    },
                ),
                (
                    "anthropic-messages",
                    "v1/messages?beta=true",
                    {
                        "x-api-key": "local-capability",
                        "anthropic-version": "2023-06-01",
                    },
                ),
            ):
                with self.subTest(protocol=protocol):
                    route = f"/scopes/{self.scope}/providers/personal_1/{protocol}/{operation}"
                    response = await client.post(
                        route, headers=headers, json={"model": "test", "stream": True}
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(
                        self.requests[-1].headers["authorization"],
                        "Bearer connector-access-token",
                    )
                    self.assertNotIn("x-api-key", self.requests[-1].headers)
                    self.assertNotIn("local-capability", str(self.requests[-1].headers))

    async def test_conflicting_capabilities_fail_before_upstream_or_connector_auth(
        self,
    ):
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{self.gateway.port}"
        ) as client:
            for headers in (
                {},
                {"x-api-key": "wrong"},
                {"Authorization": "Bearer wrong", "x-api-key": "local-capability"},
                {"Authorization": "Bearer local-capability", "x-api-key": "wrong"},
            ):
                with self.subTest(headers=headers):
                    response = await client.get("/catalog", headers=headers)
                    self.assertEqual(response.status_code, 401)
            self.assertEqual(self.token_count, 0)
            self.assertEqual(self.requests, [])
            response = await client.get(
                "/catalog",
                headers={
                    "Authorization": "Bearer local-capability",
                    "x-api-key": "local-capability",
                },
            )
            self.assertEqual(response.status_code, 200)

    async def test_unrecognized_queries_fail_closed(self):
        await self.client.get("/catalog")
        for suffix in (
            "anthropic-messages/v1/messages?beta=false",
            "anthropic-messages/v1/messages?beta=true&key=untrusted",
            "openai-responses/responses?beta=true",
        ):
            response = await self.client.post(
                f"/scopes/{self.scope}/providers/personal_1/{suffix}",
                json={"model": "test"},
            )
            self.assertEqual(response.status_code, 404)
        self.assertEqual(len(self.requests), 1)

    async def test_downstream_disconnect_cancels_upstream_stream(self):
        closed = asyncio.Event()

        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"data: first\n\n"
                await asyncio.Event().wait()

            async def aclose(self):
                closed.set()

        async def upstream(_request):
            return httpx.Response(
                200, stream=Stream(), headers={"Content-Type": "text/event-stream"}
            )

        await self.client.get("/catalog")
        await self.gateway.client.aclose()
        self.gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        route = f"/scopes/{self.scope}/providers/personal_1/openai-completions/chat/completions"
        async with self.client.stream(
            "POST", route, json={"model": "test", "stream": True}
        ) as response:
            async for chunk in response.aiter_bytes():
                self.assertIn(b"first", chunk)
                break
        await asyncio.wait_for(closed.wait(), 3)


if __name__ == "__main__":
    unittest.main()
