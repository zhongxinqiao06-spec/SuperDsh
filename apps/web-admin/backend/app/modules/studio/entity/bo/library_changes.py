"""素材三方比较与工程引用替换，不依赖数据库或界面状态。"""

from copy import deepcopy

from app.modules.studio.entity.vo.studio_vo import Document


def field_values(definition: dict) -> dict:
    return {
        "name": definition["name"],
        "description": definition.get("description", ""),
        "appearance": {"fileId": definition.get("fileId")},
        "voice": {
            "voice": definition.get("voice", ""),
            "configurationId": (definition.get("voiceBinding") or {}).get("configurationId"),
            "configurationRevision": (definition.get("voiceBinding") or {}).get("revision"),
        },
    }


def compare_fields(
    base: dict, current: dict, incoming: dict, field_bases: dict[str, dict] | None = None
) -> list[dict]:
    labels = {"name": "名称", "description": "设定", "appearance": "参考形象", "voice": "声音"}
    before, local, remote = field_values(base), field_values(current), field_values(incoming)
    for key, definition in (field_bases or {}).items():
        if key in before:
            before[key] = field_values(definition)[key]
    return [
        {
            "key": key,
            "label": label,
            "base": before[key],
            "current": local[key],
            "incoming": remote[key],
            "changed": remote[key] != before[key] and local[key] != remote[key],
            "localChanged": local[key] != before[key],
            "conflict": local[key] != before[key]
            and remote[key] != before[key]
            and local[key] != remote[key],
        }
        for key, label in labels.items()
        if key != "voice" or current["kind"] == "character"
    ]


def replace_reference(document: Document, old: str, new: str) -> Document:
    """只更新明确采用的素材引用，镜头、台词、配音任务和剪辑参数保持不变。"""
    value = deepcopy(document.model_dump())
    value["assets"] = list(dict.fromkeys(new if item == old else item for item in value["assets"]))
    if value.get("music") == old:
        value["music"] = new
    for effect in value.get("soundEffects", []):
        if effect.get("assetId") == old:
            effect["assetId"] = new
    for scene in value.get("scenes", []):
        if scene.get("sceneAssetId") == old:
            scene["sceneAssetId"] = new
    for shot in value["shots"]:
        shot["references"] = list(
            dict.fromkeys(new if item == old else item for item in shot["references"])
        )
        for field in ("sceneAssetId", "videoAssetId"):
            if shot.get(field) == old:
                shot[field] = new
        for line in shot["lines"]:
            for field in ("role", "audioAssetId"):
                if line.get(field) == old:
                    line[field] = new
    return Document.model_validate(value)


def affected_references(document: Document, asset: str) -> dict:
    scenes = {
        scene.id for scene in document.scenes if getattr(scene, "sceneAssetId", None) == asset
    }
    shots, lines = [], []
    for number, shot in enumerate(document.shots, 1):
        touched = (
            asset in shot.references
            or shot.sceneId in scenes
            or any(
                getattr(shot, field, None) == asset for field in ("sceneAssetId", "videoAssetId")
            )
        )
        for line in shot.lines:
            if line.role == asset or getattr(line, "audioAssetId", None) == asset:
                touched = True
                lines.append({"id": line.id, "shotId": shot.id})
        if touched:
            shots.append({"id": shot.id, "number": number})
    return {"shots": shots, "lines": lines}
