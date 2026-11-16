"""按稳定身份比较基线、导演草案和当前工程，未选择字段不参与写入。"""

from copy import deepcopy

from app.infrastructure.errors import DomainError


def validate_director_document(base: dict, proposed: dict) -> None:
    """所有导演写入口共用原文保护，用户手工编辑不受该规则限制。"""
    if proposed.get("adaptationMode") != base.get("adaptationMode"):
        raise DomainError(422, "改编模式由用户决定，导演不能修改")
    if base.get("adaptationMode") != "original" or not base["script"].strip():
        return
    if proposed["script"] != base["script"]:
        raise DomainError(422, "按原文制作不能改写剧本，请先由用户选择允许改编")
    original = {line["id"]: line["text"] for shot in base["shots"] for line in shot["lines"]}
    for shot in proposed["shots"]:
        for line in shot["lines"]:
            if line["text"] != original.get(line["id"]) and line["text"] not in base["script"]:
                raise DomainError(422, "原文模式的对白须来自剧本；改编需要用户授权")


def proposal_changes(base: dict, proposed: dict, current: dict) -> list[dict]:
    changes: list[dict] = []

    def add(
        key: str, label: str, before: object, after: object, now: object, path: list[str]
    ) -> None:
        if before != after:
            changes.append(
                {
                    "key": key,
                    "label": label,
                    "before": before,
                    "after": after,
                    "current": now,
                    "conflict": now != before and now != after,
                    "path": path,
                }
            )

    for field, label in (("script", "剧本正文"), ("scenes", "场次安排")):
        add(field, label, base.get(field), proposed.get(field), current.get(field), [field])
    old = {s["id"]: s for s in base["shots"]}
    new = {s["id"]: s for s in proposed["shots"]}
    live = {s["id"]: s for s in current["shots"]}
    labels = {
        "action": "动作",
        "scene": "场景",
        "sceneId": "所属场次",
        "camera": "景别",
        "framing": "构图",
        "movement": "运镜",
        "duration": "时长",
        "references": "参考素材",
        "candidate": "采用画面",
        "trimStart": "裁剪起点",
        "trimEnd": "裁剪终点",
    }
    line_labels = {
        "role": "说话角色",
        "text": "台词",
        "voice": "音色",
        "subtitle": "字幕",
        "subtitleStart": "字幕起点",
        "start": "配音起点",
        "end": "结束时间",
        "audio": "采用配音",
        "volume": "音量",
    }
    for number, identity in enumerate(dict.fromkeys([*new, *old]), 1):
        prefix = f"镜 {number}"
        a, b, c = old.get(identity), new.get(identity), live.get(identity)
        if a is None or b is None:
            add(
                "shot:" + identity,
                prefix + (" · 新增" if b else " · 移除"),
                a,
                b,
                c,
                ["shot", identity],
            )
            continue
        for field, label in labels.items():
            add(
                f"shot:{identity}:{field}",
                prefix + " · " + label,
                a.get(field),
                b.get(field),
                c.get(field) if c else {"missing": True},
                ["shot", identity, field],
            )
        oa, ob, oc = ({line["id"]: line for line in s.get("lines", [])} for s in (a, b, c or {}))
        for line_id in dict.fromkeys([*ob, *oa]):
            la, lb, lc = oa.get(line_id), ob.get(line_id), oc.get(line_id)
            if la is None or lb is None:
                add(
                    f"line:{line_id}",
                    prefix + " · 台词增删",
                    la,
                    lb,
                    lc,
                    ["line", identity, line_id],
                )
            else:
                for field, label in line_labels.items():
                    add(
                        f"line:{line_id}:{field}",
                        prefix + " · " + label,
                        la.get(field),
                        lb.get(field),
                        lc.get(field) if lc else {"missing": True},
                        ["line", identity, line_id, field],
                    )
        add(
            f"lines:{identity}:order",
            prefix + " · 台词顺序",
            list(oa),
            list(ob),
            list(oc),
            ["lines", identity],
        )
    add("shots:order", "镜头顺序", list(old), list(new), list(live), ["order"])
    return changes


def apply_changes(
    current: dict, changes: list[dict], selected: list[str], overrides: list[str]
) -> dict:
    """冲突只能由用户显式覆盖；操作基于当前工程，保留其它手工字段和新增镜头。"""
    index = {change["key"]: change for change in changes}
    if set(selected) - index.keys() or set(overrides) - set(selected):
        raise DomainError(422, "草案字段已变化，请重新审阅")
    if any(index[key]["conflict"] and key not in overrides for key in selected):
        raise DomainError(409, "部分字段已有手工修改，请明确选择保留或覆盖")
    result = deepcopy(current)
    for change in changes:
        if change["key"] not in selected:
            continue
        path, value = change["path"], deepcopy(change["after"])
        kind = path[0]
        if kind in {"script", "scenes"}:
            result[kind] = value
        elif kind == "order":
            order = {identity: position for position, identity in enumerate(value)}
            result["shots"].sort(key=lambda s: order.get(s["id"], len(order)))
        else:
            shot = next((s for s in result["shots"] if s["id"] == path[1]), None)
            if kind == "shot" and len(path) == 2:
                result["shots"] = [s for s in result["shots"] if s["id"] != path[1]]
                if value is not None:
                    result["shots"].append(value)
            elif shot is None:
                raise DomainError(409, "镜头已移除，请先处理镜头增删")
            elif kind == "shot":
                shot[path[2]] = value
            elif kind == "lines":
                order = {identity: position for position, identity in enumerate(value)}
                shot["lines"].sort(key=lambda line: order.get(line["id"], len(order)))
            elif len(path) == 3:
                shot["lines"] = [line for line in shot["lines"] if line["id"] != path[2]]
                if value is not None:
                    shot["lines"].append(value)
            else:
                line = next((line for line in shot["lines"] if line["id"] == path[2]), None)
                if line is None:
                    raise DomainError(409, "台词已移除，请重新审阅")
                line[path[3]] = value
    return result
