"""总览按时区聚合各领域公开事实，统计不触发设备或执行引擎。"""

import math
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.infrastructure.database import lock_transaction
from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.management.entity.bo.dashboard_settings import (
    dashboard_date,
    merge_settings,
    overview_range,
)
from app.modules.management.entity.do.models import DashboardSnapshotRow, SettingRow
from app.modules.management.entity.vo.system_vo import (
    DashboardSettingsInput,
    DashboardSettingsPatchInput,
)
from app.modules.management.service.system_service import SystemManagement


def records(value: object) -> list[dict[str, object]]:
    return (
        [dict(item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []
    )


def moment(value: object) -> datetime | None:
    try:
        if isinstance(value, (int, float)) or isinstance(value, str) and value.isdigit():
            numeric = float(value)
            return datetime.fromtimestamp(
                numeric / 1000 if numeric > 100_000_000_000 else numeric, UTC
            )
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.replace(tzinfo=UTC) if result.tzinfo is None else result
    except (ValueError, OverflowError, OSError):
        return None


def histogram(values: list[int], bins: list[int]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for index, boundary in enumerate(bins):
        lower = boundary if index == 0 else boundary + 1
        upper = bins[index + 1] if index + 1 < len(bins) else None
        result.append(
            {
                "key": f"{lower}-{upper}" if upper is not None else f"{lower}+",
                "label": f"{lower}-{upper}" if upper is not None else f"{lower}+",
                "min": lower,
                "max": upper,
                "count": sum(item >= lower and (upper is None or item <= upper) for item in values),
            }
        )
    return result


def breakdown(
    values: list[dict[str, object]], key: str, labels: dict[str, str]
) -> list[dict[str, object]]:
    counts = Counter(
        str(value.get(key)) if str(value.get(key)) in labels else "unknown" for value in values
    )
    total = sum(counts[name] for name in labels)
    return [
        {
            "key": name,
            "label": label,
            "value": counts[name],
            "percent": round(counts[name] / total * 100, 2) if total else 0,
        }
        for name, label in labels.items()
    ]


DEVICE_LABELS = {"macos": "macOS", "windows": "Windows", "linux": "Linux", "unknown": "Unknown"}
AGENT_LABELS = {"codex": "Codex", "claude": "Claude Code", "dsh": "DeepSeek Harness"}


def daily_users(
    facts: dict[str, object], start: datetime, end: datetime
) -> list[dict[str, object]]:
    """每个自然日只计一次活跃会话；跨日区间按各日统计求和，沿用已有总览定义。"""
    messages: Counter[str] = Counter()
    created: Counter[str] = Counter()
    sessions: dict[str, set[str]] = {}
    for kind in ("messages", "sessions", "logins"):
        for item in records(facts.get(kind)):
            at = moment(item.get("createdAt"))
            owner = str(item.get("userId") or "")
            if not owner or at is None or not start <= at < end:
                continue
            identifiers = sessions.setdefault(owner, set())
            if kind == "messages":
                messages[owner] += 1
                if item.get("sessionId"):
                    identifiers.add(str(item["sessionId"]))
            elif kind == "sessions":
                created[owner] += 1
                if item.get("id"):
                    identifiers.add(str(item["id"]))
    return [
        {
            "userId": owner,
            "messages": messages[owner],
            "active_sessions": len(values),
            "created_sessions": created[owner],
        }
        for owner, values in sessions.items()
    ]


def automatic_settings(messages: list[int], sessions: list[int]) -> dict[str, object]:
    """未手工保存阈值时使用活跃用户分位数，空样本仍返回有效零边界。"""
    counts = sorted(value for value in messages if value > 0)

    def rank(percentile: float) -> int:
        return counts[max(0, math.ceil(len(counts) * percentile) - 1)] if counts else 0

    def bins(values: list[int]) -> list[int]:
        positive = sorted(value for value in values if value > 0)
        return sorted(
            {
                0,
                *[
                    positive[math.floor((len(positive) - 1) * percentile)] if positive else 0
                    for percentile in (0.5, 0.8, 0.95)
                ],
            }
        )

    return {
        "intensity": {"basis": "messages", "lightMax": rank(0.5), "mediumMax": rank(0.8)},
        "histogramBins": {"messages": bins(messages), "sessions": bins(sessions)},
    }


class Dashboard:
    """设置、历史快照和实时聚合共享一种统计定义。"""

    def __init__(self, system: SystemManagement) -> None:
        self.system = system

    async def settings(self, account: Account) -> dict[str, object]:
        account.require("settings.manage")
        value, revision = await self.system.read_value(
            "dashboard", DashboardSettingsInput().model_dump()
        )
        return {**value, "revision": revision, "serverTime": datetime.now(UTC).isoformat()}

    async def update(
        self, account: Account, body: DashboardSettingsPatchInput
    ) -> dict[str, object]:
        account.require("settings.manage")
        async with self.system.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:identity-management")
            await self.system.current_actor(account, "settings.manage")
            row = await self.system.repository.setting(session, "dashboard")
            await self.system.repository.save_setting(
                session,
                SettingRow(
                    key="dashboard",
                    value=merge_settings(
                        row.value if row else DashboardSettingsInput().model_dump(),
                        body.model_dump(exclude_unset=True),
                    ),
                    secret=None,
                    revision=(row.revision if row else 0) + 1,
                    updated_at=datetime.now(UTC),
                ),
            )
        await self.system.identity.audit(
            account.user_id, "dashboard.settings-updated", "global", {}
        )
        return await self.settings(account)

    def range(self, start: str, end: str, zone: str) -> tuple[datetime, datetime]:
        try:
            timezone = ZoneInfo(zone)
        except (ValueError, ZoneInfoNotFoundError) as error:
            raise DomainError(422, "invalid timezone") from error
        first, last = dashboard_date(start), dashboard_date(end)
        if first > last or (last - first).days > 366:
            raise DomainError(422, "invalid dashboard range; maximum 366 days")
        return datetime.combine(first, datetime.min.time(), timezone), datetime.combine(
            last + timedelta(days=1), datetime.min.time(), timezone
        )

    @staticmethod
    def summary(facts: dict[str, object], start: datetime, end: datetime) -> dict[str, object]:
        users = records(facts.get("users"))
        users = [
            item for item in users if (at := moment(item.get("createdAt"))) is None or at < end
        ]

        def during(kind: str, beginning: datetime) -> list[dict[str, object]]:
            return [
                item
                for item in records(facts.get(kind))
                if (at := moment(item.get("createdAt"))) and beginning <= at < end
            ]

        messages, sessions, logins = (
            during("messages", start),
            during("sessions", start),
            during("logins", start),
        )
        activity = messages + sessions + logins
        active = {item.get("userId") for item in activity}
        devices = [
            item
            for item in records(facts.get("devices"))
            if (at := moment(item.get("createdAt"))) is None or at < end
        ]
        active_sessions = {item.get("sessionId") for item in messages if item.get("sessionId")} | {
            item.get("id") for item in sessions if item.get("id")
        }

        def active_users(days: int) -> int:
            return len(
                {
                    item.get("userId")
                    for kind in ("messages", "sessions", "logins")
                    for item in during(kind, end - timedelta(days=days))
                }
            )

        return {
            "totalUsers": len(users),
            "newUsers": sum(
                bool((at := moment(item.get("createdAt"))) and start <= at < end) for item in users
            ),
            "dau": active_users(1),
            "activeUsers": len({item.get("userId") for item in messages + sessions}),
            "wau": active_users(7),
            "mau": active_users(30),
            "totalMessages": len(messages),
            "activeSessions": len(active_sessions),
            "avgMessagesPerActiveUser": round(len(messages) / len(active), 2) if active else 0,
            "avgActiveSessionsPerActiveUser": round(len(active_sessions) / len(active), 2)
            if active
            else 0,
            "totalDevices": len(devices),
            "avgDevicesPerUser": round(len(devices) / len(users), 2) if users else 0,
        }

    def daily(self, facts: dict[str, object], start: datetime, end: datetime) -> dict[str, object]:
        """快照保存事实统计和设备分布，历史页面不被当前登录或后续消息悄悄改写。"""
        active: dict[str, dict[str, object]] = {}
        for kind in ("messages", "sessions"):
            for item in records(facts.get(kind)):
                at = moment(item.get("createdAt"))
                identifier = item.get("sessionId") if kind == "messages" else item.get("id")
                if identifier and at and start <= at < end:
                    active[str(identifier)] = item
        return {
            "date": start.date().isoformat(),
            "summary": self.summary(facts, start, end),
            "userFacts": daily_users(facts, start, end),
            "deviceBreakdown": breakdown(records(facts.get("devices")), "deviceOs", DEVICE_LABELS),
            "agentBreakdown": breakdown(records(facts.get("runtimes")), "type", AGENT_LABELS),
            "sessionAgentBreakdown": breakdown(list(active.values()), "agentType", AGENT_LABELS),
        }

    async def facts(
        self, account: Account, first: datetime, end: str, zone: str
    ) -> dict[str, object]:
        """公开统计事实提供器必须装配，缺依赖明确失败而不返回占位零。"""
        if self.system.facts_provider is None:
            raise DomainError(503, "dashboard facts provider is not configured")
        return await self.system.facts_provider(
            account,
            (first - timedelta(days=30)).date().isoformat(),
            end,
            zone,
        )

    async def persist(self, account: Account, values: list[DashboardSnapshotRow]) -> None:
        """快照在短事务中批量落库；读取事实和计算均不占用事务锁。"""
        if not values:
            return
        async with self.system.repository.sessions.begin() as session:
            await lock_transaction(session, "web-admin:dashboard-snapshot")
            await self.system.current_actor(account, "settings.manage")
            for row in values:
                await self.system.repository.save_snapshot(session, row)

    async def overview(
        self,
        account: Account,
        start: str,
        end: str,
        zone: str,
    ) -> dict[str, object]:
        account.require("settings.manage")
        start, end, zone = overview_range(start, end, zone)
        first, last = self.range(start, end, zone)
        now = datetime.now(UTC)
        days: list[datetime] = []
        cursor = first
        while cursor < last:
            days.append(cursor)
            cursor += timedelta(days=1)
        keys = [f"{zone}:{day.date().isoformat()}" for day in days]
        async with self.system.repository.sessions() as session:
            stored = {row.key: row for row in await self.system.repository.snapshots(session, keys)}
        facts: dict[str, object] | None = None
        snapshots: list[dict[str, object]] = []
        changed: list[DashboardSnapshotRow] = []
        today = now.astimezone(ZoneInfo(zone)).date()
        for day, key in zip(days, keys, strict=True):
            previous = stored.get(key)
            if (
                previous
                and isinstance(previous.value.get("userFacts"), list)
                and (day.date() != today or now - previous.computed_at < timedelta(minutes=5))
            ):
                value = previous.value
            else:
                if facts is None:
                    facts = await self.facts(account, first, end, zone)
                value = self.daily(facts, day, day + timedelta(days=1))
                changed.append(DashboardSnapshotRow(key=key, value=value, computed_at=now))
            snapshots.append(value)
        await self.persist(account, changed)
        message_counts: Counter[str] = Counter()
        session_counts: Counter[str] = Counter()
        for snapshot in snapshots:
            for user in records(snapshot.get("userFacts")):
                owner = str(user["userId"])
                message_counts[owner] += int(str(user["messages"]))
                session_counts[owner] += int(str(user["active_sessions"]))
        settings = await self.settings(account)
        if settings["revision"] == 0:
            settings = {
                **settings,
                **automatic_settings(list(message_counts.values()), list(session_counts.values())),
            }
        typed = DashboardSettingsInput.model_validate(
            {key: settings[key] for key in ("intensity", "histogramBins")}
        )
        segments: Counter[str] = Counter()
        for count in message_counts.values():
            if count:
                segments[
                    "light"
                    if count <= typed.intensity.lightMax
                    else "medium"
                    if count <= typed.intensity.mediumMax
                    else "heavy"
                ] += 1
        final = snapshots[-1]
        return {
            "range": {"fromDate": start, "toDate": end, "timezone": zone},
            "summary": final["summary"],
            "series": [
                {"date": snapshot["date"], **cast(dict[str, object], snapshot["summary"])}
                for snapshot in snapshots
            ],
            "messageHistogram": histogram(
                list(message_counts.values()), typed.histogramBins.messages
            ),
            "sessionHistogram": histogram(
                list(session_counts.values()), typed.histogramBins.sessions
            ),
            "userSegments": [
                {"segment": key, "label": key.title(), "count": segments[key]}
                for key in ("light", "medium", "heavy")
            ],
            "deviceBreakdown": final["deviceBreakdown"],
            "agentBreakdown": final["agentBreakdown"],
            "sessionAgentBreakdown": final["sessionAgentBreakdown"],
            "settings": settings,
            "serverTime": now.isoformat(),
        }

    async def snapshot(self, account: Account, target: str, zone: str) -> dict[str, object]:
        """显式重算指定日期；返回旧接口的生成时间与实际统计条数。"""
        account.require("settings.manage")
        zone = zone or "Asia/Shanghai"
        if target == "today":
            try:
                target = datetime.now(ZoneInfo(zone)).date().isoformat()
            except (ValueError, ZoneInfoNotFoundError) as error:
                raise DomainError(422, "invalid timezone") from error
        start, end = self.range(target, target, zone)
        facts = await self.facts(account, start, target, zone)
        value = self.daily(facts, start, end)
        computed = datetime.now(UTC)
        await self.persist(
            account,
            [DashboardSnapshotRow(key=f"{zone}:{target}", value=value, computed_at=computed)],
        )
        users = records(value["userFacts"])
        settings = await self.settings(account)
        if settings["revision"] == 0:
            settings = {
                **settings,
                **automatic_settings(
                    [int(str(row["messages"])) for row in users],
                    [int(str(row["active_sessions"])) for row in users],
                ),
            }
        typed = DashboardSettingsInput.model_validate(
            {key: settings[key] for key in ("intensity", "histogramBins")}
        )
        metrics = (
            len(self.summary(facts, start, end))
            + 1
            + len(DEVICE_LABELS)
            + len(AGENT_LABELS) * 2
            + 3
            + len(typed.histogramBins.messages)
            + len(typed.histogramBins.sessions)
        )
        return {
            "date": target,
            "computedAt": computed.isoformat(),
            "metrics": metrics,
            "users": len(users),
            "serverTime": datetime.now(UTC).isoformat(),
        }
