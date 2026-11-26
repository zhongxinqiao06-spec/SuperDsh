"""人工办理的实库测试，核对幂等、资格、收款与有效时间。"""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.billing.dao import operations_dao
from app.modules.billing.dao.membership_dao import MembershipRepository
from app.modules.billing.entity.do.operation_do import BillingOperationRow
from app.modules.billing.entity.vo.operations import OperationInput, Quote
from app.modules.billing.service.operations_service import cycle_end

BASE = "/api/admin/billing"


async def test_operation_cycle_and_replay(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    actor = await bootstrap(client)
    owner = actor["userId"]
    params = dict(
        userId=owner,
        businessKey=str(uuid4()),
        action="open",
        reason="合成测试权益",
        planVersionId="light-1",
    )
    path = BASE + "/operation-previews"
    preview = (await client.post(path, json=params)).json()
    assert preview["quote"]["immediatePoints"] == 300
    assert (await client.post(path, json=params)).json() == preview
    assert (await client.post(path, json={**params, "reason": "另一动作"})).status_code == 409
    assert (await client.get("/api/me/billing")).json()["availablePoints"] == 0
    body = {"previewId": preview["id"]}
    assert (await client.post(BASE + "/adjustments", json=body)).status_code == 422
    replies = await asyncio.gather(
        *(client.post(BASE + "/subscriptions", json=body) for _ in range(2))
    )
    assert all(r.status_code == 200 for r in replies) and replies[0].json() == replies[1].json()
    assert (await client.get("/api/me/billing")).json()["availablePoints"] == 300
    assert (
        await client.post(path, json={**params, "businessKey": str(uuid4())})
    ).status_code == 409
    params.update(action="renew", businessKey=str(uuid4()))
    renew = (await client.post(path, json=params)).json()
    assert (
        renew["quote"]["immediatePoints"] == 0
        and renew["quote"]["startsAt"] == preview["quote"]["endsAt"]
    )
    assert (
        await client.post(BASE + "/subscriptions", json={"previewId": renew["id"]})
    ).status_code == 200
    wallet = (await client.get("/api/me/billing")).json()
    assert wallet["availablePoints"] == 300 and len(wallet["lots"]) == 1
    assert wallet["subscription"]["nextGrantAt"] == renew["quote"]["startsAt"]
    assert len((await client.get("/api/me/billing/entries")).json()["items"]) == 1
    after = datetime.fromisoformat(renew["quote"]["startsAt"])
    future = await MembershipRepository(app.state.database).wallet(str(owner), after, 7, 20)
    assert (
        future.available_points == 300
        and future.subscription
        and future.subscription.next_grant_at is None
    )
    accounts = (await client.get(BASE + "/subscriptions?state=active&sku=light")).json()
    assert accounts["total"] == 1 and accounts["items"][0]["availablePoints"] == 300
    history = (await client.get(f"{BASE}/subscriptions/{owner}/operations")).json()
    assert len(history["items"]) == 2 and not history["hasMore"]


async def test_adjustment_conflicts_and_receipts(platform: tuple[FastAPI, AsyncClient]) -> None:
    app, client = platform
    assert (await client.get(BASE + "/subscriptions")).status_code == 401
    owner = (await bootstrap(client))["userId"]
    path = BASE + "/operation-previews"
    gift = dict(
        userId=owner,
        action="gift",
        reason="运营赠送",
        businessKey=str(uuid4()),
        points=100,
        validDays=30,
    )

    async def preview(data: dict[str, object]) -> str:
        r = await client.post(path, json=data)
        assert r.status_code == 200, r.text
        return str(r.json()["id"])

    a, b = await preview(gift), await preview({**gift, "businessKey": str(uuid4())})
    assert (await client.post(BASE + "/adjustments", json={"previewId": a})).status_code == 200
    assert (await client.post(BASE + "/adjustments", json={"previewId": b})).status_code == 409
    topup = dict(
        userId=owner,
        action="topup",
        reason="线下登记",
        planVersionId="extra-1",
        businessKey=str(uuid4()),
        payment="offline",
        receipt="SYN-001",
        receivedFen=1900,
    )
    assert (await client.post(path, json={**topup, "receivedFen": 100})).status_code == 422
    c = await preview(topup)
    assert (await client.post(BASE + "/adjustments", json={"previewId": c})).status_code == 200
    d = await preview({**topup, "businessKey": str(uuid4())})
    assert (await client.post(BASE + "/adjustments", json={"previewId": d})).status_code == 409
    assert (await client.get("/api/me/billing")).json()["availablePoints"] == 280
    stale = await preview({**gift, "businessKey": str(uuid4()), "action": "compensation"})
    async with app.state.database.sessions.begin() as db:
        await db.execute(
            update(BillingOperationRow)
            .where(BillingOperationRow.id == stale)
            .values(created_at=datetime.now(UTC) - timedelta(hours=1))
        )
        assert (
            len(
                (
                    await db.scalars(
                        select(BillingOperationRow).where(
                            BillingOperationRow.confirmed_at.is_not(None)
                        )
                    )
                ).all()
            )
            == 2
        )
    assert (await client.post(BASE + "/adjustments", json={"previewId": stale})).status_code == 409
    assert (
        await client.post(path, json={**gift, "userId": "missing", "businessKey": str(uuid4())})
    ).status_code == 409


def test_month_end_anchor() -> None:
    january = datetime(2028, 1, 31, 12, tzinfo=UTC)
    february = cycle_end(january, 1, 31)
    assert february.day == 29 and cycle_end(february, 1, 31).day == 31


async def test_failed_booking_rolls_back(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """实收已核验后发生入账故障，原单、凭证和会员状态整体恢复，可用原预览重试。"""
    _, client = platform
    owner = (await bootstrap(client))["userId"]
    r = await client.post(
        BASE + "/operation-previews",
        json=dict(
            userId=owner,
            businessKey=str(uuid4()),
            action="open",
            planVersionId="light-1",
            reason="回滚测试",
            payment="offline",
            receipt="rollback-fixture",
            receivedFen=2900,
        ),
    )
    assert r.status_code == 200
    body = {"previewId": r.json()["id"]}
    original = operations_dao.record_grant

    async def fail_after_flush(
        db: AsyncSession,
        op: BillingOperationRow,
        request: OperationInput,
        quote: Quote,
        at: datetime,
    ) -> None:
        await original(db, op, request, quote, at)
        await db.flush()
        raise RuntimeError("synthetic billing failure")

    with monkeypatch.context() as patch:
        patch.setattr(operations_dao, "record_grant", fail_after_flush)
        with pytest.raises(RuntimeError, match="synthetic billing failure"):
            await client.post(BASE + "/subscriptions", json=body)
    assert (await client.get("/api/me/billing")).json()["subscription"] is None
    assert (await client.get("/api/me/billing/entries")).json()["items"] == []
    assert (await client.post(BASE + "/subscriptions", json=body)).status_code == 200
    assert (await client.get("/api/me/billing")).json()["availablePoints"] == 300
