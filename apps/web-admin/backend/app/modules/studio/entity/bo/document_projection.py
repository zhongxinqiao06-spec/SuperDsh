"""旧导演/媒体契约与结构化当前工程之间的纯转换，保存时保留稳定身份。"""

from typing import Any

from app.modules.studio.entity.bo.foundation import stable_id
from app.modules.studio.entity.vo.studio_vo import Document


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
        {
            "id": scene.id,
            "title": scene.title,
            "synopsis": scene.synopsis,
            "position": index,
            "script_range": scene.scriptRange.model_dump() if scene.scriptRange else None,
            "scene_asset_id": scene.sceneAssetId,
        }
        for index, scene in enumerate(document.scenes)
    ]
    scene_ids = {scene.id for scene in document.scenes}
    cursor = 0
    offsets: dict[str, int] = {}
    for position, shot in enumerate(document.shots):
        offsets[shot.id] = cursor - shot.trimStart
        scene_id = shot.sceneId or stable_id(project, "scene:" + shot.scene)
        shot.sceneId = scene_id
        if scene_id not in scene_ids:
            rows["scenes"].append(
                {
                    "id": scene_id,
                    "title": shot.scene or "未命名场次",
                    "synopsis": "",
                    "script_range": None,
                    "scene_asset_id": None,
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
                "scene_asset_id": shot.sceneAssetId,
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
                "asset_version_id": shot.videoAssetId,
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
            voice_length = durations.get(line.audio or line.audioAssetId or "", 0)
            rows["clips"].append(
                {
                    "id": stable_id(project, "voice:" + line.id),
                    "track_id": "voice",
                    "line_id": line.id,
                    "role": "primary_voice",
                    "job_id": line.audio,
                    "asset_version_id": line.audioAssetId,
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
    for effect in document.soundEffects:
        offset = offsets[effect.shotId] if effect.shotId else 0
        end = effect.trimEnd if effect.trimEnd is not None else durations.get(effect.assetId, 0)
        rows["clips"].append(
            {
                "id": stable_id(project, "effect:" + effect.id),
                "track_id": "sound",
                "role": "sound_effect",
                "effect_id": effect.id,
                "shot_id": effect.shotId,
                "asset_version_id": effect.assetId,
                "start_ticks": max(0, offset + effect.start) * scale,
                "anchor_offset_ticks": effect.start * scale,
                "duration_ticks": max(0, end - effect.trimStart) * scale,
                "source_start_ticks": effect.trimStart * scale,
                "timing_mode": "auto" if effect.trimEnd is None else "manual",
                "gain": effect.volume,
            }
        )
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


def read_document(rows: dict[str, Any]) -> Document:
    """兼容响应由当前行生成；媒体采用状态只从片段读取。"""
    scale = rows["timeline"].ticks_per_second // 1000
    clips = {(clip.role, clip.shot_id or clip.line_id): clip for clip in rows["clips"]}
    assets = sorted(
        [(r.position, r.asset_version_id) for r in rows["media"]]
        + [(r.position, r.entity_version_id) for r in rows["entities"]]
    )
    shots = []
    for shot in sorted(rows["shots"], key=lambda r: r.position):
        clip = clips[("primary_video", shot.id)]
        trim = clip.source_start_ticks // scale
        lines = []
        for line in sorted(
            (r for r in rows["lines"] if r.shot_id == shot.id), key=lambda r: r.position
        ):
            voice, caption = clips[("primary_voice", line.id)], clips[("subtitle", line.id)]
            caption_start = caption.anchor_offset_ticks // scale + trim
            lines.append(
                {
                    "id": line.id,
                    "role": line.speaker_version_id,
                    "text": line.text,
                    "voice": line.voice,
                    "start": voice.anchor_offset_ticks // scale + trim,
                    "audio": voice.job_id,
                    "audioAssetId": voice.asset_version_id,
                    "volume": voice.gain,
                    "subtitle": caption.subtitle_text,
                    "subtitleStart": None if caption.subtitle_follow_voice else caption_start,
                    "end": None
                    if caption.timing_mode == "auto"
                    else caption_start + caption.duration_ticks // scale,
                }
            )
        shots.append(
            {
                "id": shot.id,
                "sceneId": shot.story_scene_id,
                "action": shot.action,
                "scene": shot.scene,
                "sceneAssetId": shot.scene_asset_id,
                "camera": shot.camera,
                "framing": shot.framing,
                "movement": shot.movement,
                "duration": shot.planned_duration_ms,
                "references": [
                    ref.entity_version_id or ref.asset_version_id
                    for ref in sorted(
                        (r for r in rows["references"] if r.shot_id == shot.id),
                        key=lambda r: r.position,
                    )
                ],
                "lines": lines,
                "candidate": clip.job_id,
                "videoAssetId": clip.asset_version_id,
                "trimStart": trim,
                "trimEnd": None
                if clip.timing_mode == "auto"
                else trim + clip.duration_ticks // scale,
            }
        )
    music = next((clip for clip in rows["clips"] if clip.track_id == "music"), None)
    return Document.model_validate(
        {
            "script": rows["script"].source_text,
            "adaptationMode": rows["script"].adaptation_mode,
            "scenes": [
                {
                    "id": r.id,
                    "title": r.title,
                    "synopsis": r.synopsis,
                    "scriptRange": r.script_range,
                    "sceneAssetId": r.scene_asset_id,
                }
                for r in sorted(rows["scenes"], key=lambda r: r.position)
            ],
            "assets": [item[1] for item in assets],
            "shots": shots,
            "music": music.asset_version_id if music else None,
            "musicVolume": rows["timeline"].music_gain,
            "soundEffects": [
                {
                    "id": clip.effect_id,
                    "assetId": clip.asset_version_id,
                    "shotId": clip.shot_id,
                    "start": clip.anchor_offset_ticks // scale,
                    "volume": clip.gain,
                    "trimStart": clip.source_start_ticks // scale,
                    "trimEnd": None
                    if clip.timing_mode == "auto"
                    else (clip.source_start_ticks + clip.duration_ticks) // scale,
                }
                for clip in rows["clips"]
                if clip.role == "sound_effect"
            ],
        }
    )
