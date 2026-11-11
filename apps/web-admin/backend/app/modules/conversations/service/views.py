"""工作台持久实体转为兼容客户端的只读视图。"""

from app.modules.conversations.entity.do.models import ProjectRow, SessionRow


def effective_capabilities(
    row: SessionRow, source: dict[str, object], online: bool
) -> dict[str, object]:
    """按会话、运行时优先级投影能力；未接管状态不能被客户端能力声明绕过。"""
    raw = source.get("capabilities", [])
    candidates = (
        [
            item
            for item in raw
            if isinstance(item, dict)
            and (not item.get("runtime") or item.get("runtime") == row.runtime_type)
            and (not item.get("runtimeId") or item.get("runtimeId") == row.runtime_id)
            and (not item.get("sessionId") or item.get("sessionId") == row.id)
        ]
        if isinstance(raw, list)
        else []
    )
    selected: dict[str, dict[str, object]] = {}
    for item in candidates:
        selected.setdefault(str(item.get("capabilityId", "")), item)
    for item in sorted(
        candidates,
        key=lambda item: (bool(item.get("sessionId")), bool(item.get("runtimeId"))),
        reverse=True,
    ):
        identifier = str(item.get("capabilityId", ""))
        prior = selected[identifier]
        if (bool(item.get("sessionId")), bool(item.get("runtimeId"))) > (
            bool(prior.get("sessionId")),
            bool(prior.get("runtimeId")),
        ):
            selected[identifier] = item
    return {
        "revision": max(int(str(source.get("revision", 0))), row.sequence),
        "capabilities": [
            {
                **item,
                "scope": "session",
                "runtime": row.runtime_type,
                "runtimeId": row.runtime_id,
                "sessionId": row.id,
                "available": bool(item.get("supported") and item.get("available") and online),
                "allowed": item.get("allowed") is not False and bool(row.takeover),
                "unavailableReason": (
                    "runtime_capability_unsupported"
                    if not item.get("supported")
                    else "connector_offline"
                    if not online
                    else "session_not_taken_over"
                    if not row.takeover
                    else item.get("unavailableReason")
                ),
            }
            for item in selected.values()
        ],
    }


def runtime_state_view(row: SessionRow) -> dict[str, object]:
    """身份与状态以会话持久事实为准，旧运行扩展字段不能覆盖服务端权威值。"""
    return {
        "selections": {},
        "statusReason": None,
        "error": None,
        "metadata": {},
        **row.state,
        "sessionId": row.id,
        "runtime": row.runtime_type,
        "runtimeId": row.runtime_id or row.runtime_type,
        "runtimeType": row.runtime_type,
        "externalSessionId": row.external_session_id or None,
        "status": row.status,
        "updatedSeq": row.sequence,
        "createdAt": row.created_at.isoformat(),
        "updatedAt": row.updated_at.isoformat(),
    }


def session_view(row: SessionRow, online: bool = False) -> dict[str, object]:
    """状态字段保持三端一致，归档只表达用户操作而不删除源历史。"""
    return {
        "id": row.id,
        "connectorId": row.connector_id,
        "executorKind": "server-agent"
        if row.connector_id.startswith("conn_server_")
        else "desktop",
        "projectId": row.project_id,
        "connectorStatus": "online" if online else "offline",
        "runtime": row.runtime_type,
        "runtimeId": row.runtime_id,
        "runtimeType": row.runtime_type,
        "runtimeName": row.source.get("runtimeName"),
        "runtimeTypeDisplayName": row.source.get("runtimeTypeDisplayName"),
        "externalSessionId": row.external_session_id,
        "agentDefinition": row.agent_binding.get("definition") if row.agent_binding else None,
        "title": row.title,
        "cwd": row.cwd or None,
        "status": row.status,
        "takeover": row.takeover,
        "pinned": row.pinned,
        "pinnedAt": row.pinned_at.isoformat() if row.pinned_at else None,
        "archived": row.archived,
        "archivedAt": row.archived_at.isoformat() if row.archived_at else None,
        "userArchived": row.archived,
        "sourceAvailability": row.source.get("availability", "available"),
        "sourceAvailabilityReason": row.source.get("reason"),
        "sourceAvailabilityUpdatedAt": row.source.get("availabilityUpdatedAt"),
        "sourceObservationOrigin": row.source.get("observationOrigin"),
        "lastSyncedAt": row.source.get("lastSyncedAt"),
        "sourceObservedAt": row.source.get("observedAt"),
        "archiveSource": (
            "both"
            if row.archived and row.source.get("availability") == "archived"
            else "user"
            if row.archived
            else "runtime"
            if row.source.get("availability") == "archived"
            else None
        ),
        "unread": row.latest_turn_end_seq > row.last_read_seq,
        "lastReadSeq": row.last_read_seq,
        "latestTurnEndSeq": row.latest_turn_end_seq,
        "lastActivityAt": row.last_activity_at.isoformat() if row.last_activity_at else None,
        "lastItemAt": row.last_item_at.isoformat() if row.last_item_at else None,
        "lastItemOrderSeq": row.last_item_order_seq,
        "sortAt": (row.sort_at or row.created_at).isoformat(),
        "updatedSeq": row.sequence,
        "createdAt": row.created_at.isoformat(),
    }


def project_view(row: ProjectRow, sessions: list[SessionRow]) -> dict[str, object]:
    owned = [item for item in sessions if item.project_id == row.id]
    activity = max((item.last_activity_at for item in owned if item.last_activity_at), default=None)
    return {
        "id": row.id,
        "userId": row.owner_id,
        "connectorId": row.connector_id,
        "name": row.name,
        "workspacePath": row.workspace_path,
        "manuallyCreated": row.manually_created,
        "pinned": row.pinned,
        "pinnedAt": row.pinned_at.isoformat() if row.pinned_at else None,
        "activeSessionCount": sum(not item.archived for item in owned),
        "sidebarSessionCounts": {
            "active": sum(not item.archived for item in owned),
            "archived": sum(item.archived for item in owned),
        },
        "lastActivityAt": activity.isoformat() if activity else None,
        "createdAt": row.created_at.isoformat(),
        "updatedAt": row.updated_at.isoformat(),
    }
