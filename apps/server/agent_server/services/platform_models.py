from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from typing import Any, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import delete, insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_server.core.platform_models import (
    ModelSelection,
    ProviderView,
    ProviderWrite,
)
from agent_server.core.utc import utc_now
from agent_server.infra.db.platform_models import defaults, providers


class PlatformModelStore(Protocol):
    engine: AsyncEngine

    async def record_audit(
        self, actor_id: str, action: str, target_id: str, detail: dict | None = None
    ) -> None: ...


class ModelConfigurationError(ValueError):
    pass


class PlatformModels:
    def __init__(self, store: PlatformModelStore, owner_id: str | None = None) -> None:
        self.store = store
        self.owner_id = owner_id

    def _scope(self):
        return (
            providers.c.owner_user_id == self.owner_id
            if self.owner_id
            else providers.c.owner_user_id.is_(None)
        )

    def _credential_identity(self, provider_id: str) -> str:
        return (
            f"personal:{self.owner_id}:{provider_id}" if self.owner_id else provider_id
        )

    @property
    def default_id(self) -> str:
        return f"user:{self.owner_id}" if self.owner_id else "global"

    @staticmethod
    async def _lock_configuration(conn: Any) -> None:
        # Serialize defaults with provider edits across API workers. SQLite test
        # transactions already serialize writes; production uses PostgreSQL.
        if conn.dialect.name == "postgresql":
            await conn.execute(text("SELECT pg_advisory_xact_lock(734521903)"))

    @staticmethod
    def _key() -> bytes:
        # Separate from login signing: rotating JWT secrets must not lose provider keys.
        configured = os.environ.get("SUPERDSH_MODEL_ENCRYPTION_KEY", "")
        try:
            key = base64.urlsafe_b64decode(configured)
        except (ValueError, TypeError) as exc:
            raise ModelConfigurationError(
                "platform model encryption key is not configured"
            ) from exc
        if len(key) != 32:
            raise ModelConfigurationError(
                "SUPERDSH_MODEL_ENCRYPTION_KEY must encode 32 bytes"
            )
        return key

    @classmethod
    def _seal(cls, value: str, provider_id: str) -> str:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(cls._key()).encrypt(
            nonce, value.encode(), provider_id.encode()
        )
        return base64.urlsafe_b64encode(nonce + ciphertext).decode()

    @classmethod
    def _open(cls, value: str, provider_id: str) -> str:
        try:
            data = base64.urlsafe_b64decode(value)
            return (
                AESGCM(cls._key())
                .decrypt(data[:12], data[12:], provider_id.encode())
                .decode()
            )
        except ModelConfigurationError:
            raise
        except Exception as exc:
            raise ModelConfigurationError(
                "platform provider credential cannot be decrypted"
            ) from exc

    @staticmethod
    def _view(row: Any) -> ProviderView:
        return ProviderView(
            providerId=row.id,
            name=row.name,
            protocol=row.protocol,
            baseUrl=row.base_url,
            models=json.loads(row.models_json),
            enabled=bool(row.enabled),
            apiKeyConfigured=bool(row.key_ciphertext),
            createdAt=row.created_at,
            updatedAt=row.updated_at,
            source="personal" if row.owner_user_id else "platform",
        )

    async def list(self) -> list[ProviderView]:
        async with self.store.engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(providers)
                    .where(self._scope())
                    .order_by(providers.c.name, providers.c.id)
                )
            ).all()
        return [self._view(row) for row in rows]

    async def default(self) -> ModelSelection | None:
        async with self.store.engine.connect() as conn:
            row = (
                await conn.execute(
                    select(defaults).where(defaults.c.id == self.default_id)
                )
            ).first()
        return (
            ModelSelection(providerId=row.provider_id, modelId=row.model_id)
            if row
            else None
        )

    async def save(
        self, payload: ProviderWrite, actor_id: str, provider_id: str | None = None
    ) -> ProviderView:
        creating = provider_id is None
        provider_id = (
            provider_id
            or f"{'personal' if self.owner_id else 'platform'}-{secrets.token_hex(8)}"
        )
        now = utc_now()
        async with self.store.engine.begin() as conn:
            await self._lock_configuration(conn)
            row = (
                await conn.execute(
                    select(providers)
                    .where(providers.c.id == provider_id, self._scope())
                    .with_for_update()
                )
            ).first()
            if row is None and not creating:
                raise KeyError(provider_id)
            ciphertext = row.key_ciphertext if row else None
            if payload.apiKey:
                ciphertext = self._seal(
                    payload.apiKey, self._credential_identity(provider_id)
                )
            elif payload.clearApiKey:
                ciphertext = None
            selected = (
                await conn.execute(
                    select(defaults).where(defaults.c.provider_id == provider_id)
                )
            ).first()
            if selected and (
                not payload.enabled
                or selected.model_id not in {item.modelId for item in payload.models}
            ):
                raise ModelConfigurationError(
                    "change the default selection before disabling or removing its model"
                )
            values = {
                "name": payload.name,
                "protocol": payload.protocol,
                "base_url": payload.baseUrl,
                "key_ciphertext": ciphertext,
                "models_json": json.dumps(
                    [item.model_dump() for item in payload.models]
                ),
                "enabled": int(payload.enabled),
                "updated_at": now,
            }
            if row:
                await conn.execute(
                    update(providers)
                    .where(providers.c.id == provider_id, self._scope())
                    .values(**values)
                )
            else:
                await conn.execute(
                    insert(providers).values(
                        id=provider_id,
                        owner_user_id=self.owner_id,
                        created_at=now,
                        **values,
                    )
                )
        await self.store.record_audit(actor_id, "models.provider.save", provider_id)
        return next(
            item for item in await self.list() if item.providerId == provider_id
        )

    async def remove(self, provider_id: str, actor_id: str) -> None:
        async with self.store.engine.begin() as conn:
            await self._lock_configuration(conn)
            if not (
                await conn.execute(
                    select(providers.c.id).where(
                        providers.c.id == provider_id, self._scope()
                    )
                )
            ).first():
                raise KeyError(provider_id)
            await conn.execute(
                delete(defaults).where(defaults.c.provider_id == provider_id)
            )
            result = await conn.execute(
                delete(providers).where(providers.c.id == provider_id, self._scope())
            )
            if not result.rowcount:
                raise KeyError(provider_id)
        await self.store.record_audit(actor_id, "models.provider.delete", provider_id)

    async def set_default(
        self, selection: ModelSelection | None, actor_id: str
    ) -> None:
        async with self.store.engine.begin() as conn:
            await self._lock_configuration(conn)
            if selection:
                row = (
                    await conn.execute(
                        select(providers)
                        .where(providers.c.id == selection.providerId, self._scope())
                        .with_for_update()
                    )
                ).first()
                if (
                    not row
                    or not row.enabled
                    or selection.modelId
                    not in {item["modelId"] for item in json.loads(row.models_json)}
                ):
                    raise ModelConfigurationError(
                        "default must select an enabled configured model"
                    )
            await conn.execute(delete(defaults).where(defaults.c.id == self.default_id))
            if selection:
                await conn.execute(
                    insert(defaults).values(
                        id=self.default_id,
                        provider_id=selection.providerId,
                        model_id=selection.modelId,
                        updated_at=utc_now(),
                    )
                )
        await self.store.record_audit(actor_id, "models.default.save", self.default_id)

    async def catalog(self) -> dict[str, Any]:
        enabled = [item for item in await self.list() if item.enabled]
        return {
            "providers": [
                item.model_dump(
                    exclude={
                        "baseUrl",
                        "apiKeyConfigured",
                        "enabled",
                        "createdAt",
                        "updatedAt",
                    }
                )
                for item in enabled
            ],
            "default": await self.default(),
            "serverTime": utc_now(),
        }

    async def resolve(
        self, provider_id: str, protocol: str, model_id: str
    ) -> tuple[str, str | None]:
        async with self.store.engine.connect() as conn:
            row = (
                await conn.execute(
                    select(providers).where(
                        providers.c.id == provider_id, self._scope()
                    )
                )
            ).first()
        if not row or not row.enabled or row.protocol != protocol:
            raise KeyError(provider_id)
        if model_id not in {item["modelId"] for item in json.loads(row.models_json)}:
            raise ModelConfigurationError("requested model is unavailable")
        key = (
            self._open(row.key_ciphertext, self._credential_identity(provider_id))
            if row.key_ciphertext
            else None
        )
        return row.base_url, key


async def catalog_for_user(store: PlatformModelStore, owner_id: str) -> dict[str, Any]:
    personal = await PlatformModels(store, owner_id).catalog()
    platform = await PlatformModels(store).catalog()
    return {
        "scope": hashlib.sha256(f"user:{owner_id}".encode()).hexdigest(),
        "providers": personal["providers"] + platform["providers"],
        "default": personal["default"] or platform["default"],
        "personalDefault": personal["default"],
        "platformDefault": platform["default"],
        "serverTime": utc_now(),
    }


async def resolve_for_user(
    store: PlatformModelStore,
    owner_id: str,
    provider_id: str,
    protocol: str,
    model_id: str,
) -> tuple[str, str | None, bool]:
    try:
        url, key = await PlatformModels(store, owner_id).resolve(
            provider_id, protocol, model_id
        )
        return url, key, True
    except KeyError:
        url, key = await PlatformModels(store).resolve(provider_id, protocol, model_id)
        return url, key, False
