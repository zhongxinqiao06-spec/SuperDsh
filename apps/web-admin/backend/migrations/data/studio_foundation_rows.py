"""随基础迁移冻结的转换函数，禁止导入运行时业务模块。"""

from typing import Any
from uuid import NAMESPACE_URL, uuid5

Document = Any


def stable_id(scope: str, source: str) -> str:
    """导入和重试得到同一身份，不依赖目录顺序或当前时间。"""
    return uuid5(NAMESPACE_URL, f"superdsh/studio/{scope}/{source}").hex


def project_rows(
    project: str, document: Document, kinds: dict[str, str], rate: int, durations: dict[str, int]
) -> dict[str, list[dict[str, Any]]]:
    rows: dict[str, list[dict[str, Any]]] = {
        key: [] for key in ("scenes", "shots", "lines", "references", "media", "entities", "clips")
    }
    scale = rate // 1000
    for index, asset in enumerate(document.assets):
        entity = kinds[asset] in {"character", "scene", "prop"}
        rows["entities" if entity else "media"].append(
            {"entity_version_id" if entity else "asset_version_id": asset, "position": index}
        )
    rows["scenes"] = [
        {"id": scene.id, "title": scene.title, "synopsis": scene.synopsis, "position": index}
        for index, scene in enumerate(document.scenes)
    ]
    scene_ids = {scene.id for scene in document.scenes}
    cursor = 0
    for position, shot in enumerate(document.shots):
        scene_id = shot.sceneId or stable_id(project, "scene:" + shot.scene)
        shot.sceneId = scene_id
        if scene_id not in scene_ids:
            rows["scenes"].append(
                {
                    "id": scene_id,
                    "title": shot.scene or "未命名场次",
                    "synopsis": "",
                    "position": len(scene_ids),
                }
            )
            scene_ids.add(scene_id)
        rows["shots"].append(
            {
                "id": shot.id,
                "story_scene_id": scene_id,
                "position": position,
                "action": shot.action,
                "scene": shot.scene,
                "camera": shot.camera,
                "framing": shot.framing,
                "movement": shot.movement,
                "planned_duration_ms": shot.duration,
            }
        )
        length = (shot.trimEnd if shot.trimEnd is not None else shot.duration) - shot.trimStart
        rows["clips"].append(
            {
                "id": stable_id(project, "video:" + shot.id),
                "track_id": "video",
                "shot_id": shot.id,
                "role": "primary_video",
                "job_id": shot.candidate,
                "start_ticks": cursor * scale,
                "duration_ticks": length * scale,
                "source_start_ticks": shot.trimStart * scale,
                "source_duration_ticks": length * scale,
                "timing_mode": "auto" if shot.trimEnd is None else "manual",
            }
        )
        for order, ref in enumerate(shot.references):
            entity = kinds[ref] in {"character", "scene", "prop"}
            rows["references"].append(
                {
                    "shot_id": shot.id,
                    "position": order,
                    "entity_version_id" if entity else "asset_version_id": ref,
                }
            )
        for order, line in enumerate(shot.lines):
            rows["lines"].append(
                {
                    "id": line.id,
                    "shot_id": shot.id,
                    "position": order,
                    "speaker_version_id": line.role,
                    "text": line.text,
                    "voice": line.voice,
                }
            )
            offset = line.start - shot.trimStart
            voice_length = durations.get(line.audio or "", 0)
            rows["clips"].append(
                {
                    "id": stable_id(project, "voice:" + line.id),
                    "track_id": "voice",
                    "line_id": line.id,
                    "role": "primary_voice",
                    "job_id": line.audio,
                    "start_ticks": (cursor + max(0, offset)) * scale,
                    "duration_ticks": max(0, voice_length - max(0, -offset)) * scale,
                    "source_start_ticks": max(0, -offset) * scale,
                    "anchor_offset_ticks": offset * scale,
                    "gain": line.volume,
                }
            )
            start = line.start if line.subtitleStart is None else line.subtitleStart
            end = shot.duration if line.end is None else line.end
            rows["clips"].append(
                {
                    "id": stable_id(project, "subtitle:" + line.id),
                    "track_id": "subtitle",
                    "line_id": line.id,
                    "role": "subtitle",
                    "start_ticks": (cursor + max(0, start - shot.trimStart)) * scale,
                    "duration_ticks": max(0, end - start) * scale,
                    "anchor_offset_ticks": (start - shot.trimStart) * scale,
                    "subtitle_text": line.subtitle,
                    "subtitle_follow_voice": line.subtitleStart is None,
                    "timing_mode": "auto" if line.end is None else "manual",
                }
            )
        cursor += length
    if document.music:
        rows["clips"].append(
            {
                "id": stable_id(project, "music"),
                "track_id": "music",
                "role": "free_media",
                "asset_version_id": document.music,
                "start_ticks": 0,
                "duration_ticks": cursor * scale,
                "gain": document.musicVolume,
            }
        )
    return rows
