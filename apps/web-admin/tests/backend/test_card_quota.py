"""同一任务混合抵扣，跨周释放及月上限。使用隔离账号和真正的发放事务。"""

import asyncio
import json
from datetime import UTC, datetime, timedelta, tzinfo
from uuid import uuid4

import pytest
from conftest import bootstrap
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text

from app.infrastructure.errors import DomainError
from app.modules.billing.dao import usage_credit
from app.modules.billing.dao.membership_dao import MembershipRepository
from app.modules.billing.entity.do.credit_do import CreditLotRow
from app.modules.billing.entity.vo.dto import Wallet


async def test_period_caps_and_fixed_card(
    platform: tuple[FastAPI, AsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    app, client = platform
    await bootstrap(client)
    created = await client.post(
        "/api/admin/users",
        json=dict(
            username="quota-member",
            displayName="隔离额度用户",
            password="Synthetic-quota-123!",
            roles=["member"],
        ),
    )
    assert created.status_code == 201, created.text
    owner = created.json()["userId"]

    async def issue(action: str, **data: object) -> dict:
        preview = await client.post(
            "/api/admin/billing/operation-previews",
            json=dict(
                userId=owner,
                action=action,
                businessKey=str(uuid4()),
                reason="隔离测试",
                **data,
            ),
        )
        assert preview.is_success, preview.text
        destination = "subscriptions" if action == "open" else "adjustments"
        confirm = await client.post(
            "/api/admin/billing/" + destination,
            json={"previewId": preview.json()["id"]},
        )
        assert confirm.is_success, confirm.text
        return confirm.json()

    order = await issue("open", planVersionId="creator-1")
    await issue("gift", points=80, validDays=45)
    await issue("card", points=200, validDays=45, cardTypeId="slate", cardRevision=1)
    db = app.state.database
    now = datetime.now(UTC) + timedelta(seconds=2)

    class Clock:
        @staticmethod
        def now(tz: tzinfo | None = None) -> datetime:
            return now

    monkeypatch.setattr(usage_credit, "datetime", Clock)

    async def reserve(job: str, points: int) -> None:
        async with db.sessions.begin() as session:
            await usage_credit.reserve_jobs(session, owner, [(job, points)])

    async def finish(job: str, used: bool) -> None:
        async with db.sessions.begin() as session:
            await usage_credit.finish_job(session, owner, job, used=used)

    async def wallet() -> Wallet:
        return await MembershipRepository(db).wallet(owner, now, 7, 20)

    await reserve("earlier", 400)
    await finish("earlier", True)
    await reserve("split", 220)
    w = await wallet()
    assert w.quota and (
        w.quota.weekly_remaining,
        w.quota.monthly_remaining,
        w.ordinary_points,
        w.card_points,
    ) == (0, 1000, 0, 160)
    assert w.held_points == 220
    await finish("split", True)
    await finish("split", True)
    with pytest.raises(DomainError, match="需要"):
        await reserve("too-large", 161)
    assert (await wallet()).held_points == 0
    now += timedelta(days=7)
    await reserve("late-release", 100)
    now += timedelta(days=7)
    await finish("late-release", False)
    w = await wallet()
    assert w.quota and (w.quota.weekly_remaining, w.quota.monthly_remaining) == (
        500,
        1000,
    )
    await reserve("another-week", 500)
    await finish("another-week", True)
    now += timedelta(days=7)
    results = await asyncio.gather(reserve("one", 420), reserve("two", 420), return_exceptions=True)
    assert len([r for r in results if isinstance(r, DomainError)]) == 1
    await reserve("remainder", 80)
    w = await wallet()
    assert w.quota and w.quota.monthly_remaining == 0
    if w.quota.week_ends_at < w.quota.month_ends_at:
        now = w.quota.week_ends_at
        w = await wallet()
        assert w.quota and w.quota.weekly_remaining == 500 and w.quota.monthly_remaining == 0
    assert w.available_points == 160
    async with db.sessions() as session:
        lot = await session.scalar(
            select(CreditLotRow).where(CreditLotRow.source_key == "membership_grant:" + order["id"])
        )
        assert lot and lot.held == 500


async def test_card_revision_and_annual_month_boundary(
    platform: tuple[FastAPI, AsyncClient],
) -> None:
    app, client = platform
    actor = await bootstrap(client)
    root = "/api/admin/billing"
    types = (await client.get(root + "/card-types")).json()["items"]
    card = next(x.copy() for x in types if x["id"] == "lens")
    path = root + "/card-types/" + card.pop("id")
    issue = {
        "userId": actor["userId"],
        "action": "card",
        "points": 500,
        "validDays": 17,
        "cardTypeId": "lens",
        "cardRevision": card["revision"],
        "businessKey": str(uuid4()),
        "reason": "卡种修订联调",
    }
    pending = (await client.post(root + "/operation-previews", json=issue)).json()
    revised = await client.put(path, json={**card, "points": 720, "name": "新取景卡"})
    assert revised.is_success, revised.text
    assert (
        await client.post(root + "/adjustments", json={"previewId": pending["id"]})
    ).status_code == 409
    assert (await client.get("/api/me/billing/cards")).json()["items"] == []
    assert (await client.put(path, json={**card, "points": 900})).status_code == 409
    invalid_pic = await client.put(
        path, json={**card, "revision": 2, "image": "data:image/png;base64,Zm9v"}
    )
    assert invalid_pic.status_code == 422
    image = (await client.get(root + "/card-types")).json()["items"]
    assert next(x for x in image if x["id"] == "lens")["revision"] == 2
    # 年卡的月末锚点不能在二月截断后逐月漂移。跨年也保留时分秒。
    async with app.state.database.sessions() as session:
        sample = {
            "created_at": "2028-01-31T08:30:00Z",
            "expires_at": "2029-01-31T08:30:00Z",
            "weekly_limit": 500,
            "monthly_limit": 1500,
            "remaining": 18000,
            "held": 0,
        }
        sql = text("""SELECT week_ends_at,month_ends_at FROM billing_member_quota(
            jsonb_populate_record(null::billing_credit_lots,cast(:sample as jsonb)),:at)""")
        start = datetime(2028, 2, 29, 8, 30, tzinfo=UTC)
        w, m = (await session.execute(sql, {"at": start, "sample": json.dumps(sample)})).one()
        assert (w, m) == (start + timedelta(days=7), datetime(2028, 3, 31, 8, 30, tzinfo=UTC))
