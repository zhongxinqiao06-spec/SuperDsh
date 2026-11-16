"""创作基础迁移的冻结转换；保留旧资产、工程修订和供应商回执。"""

import hashlib
import json
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

import sqlalchemy as sa


def stable(scope: str, value: str) -> str:
    return uuid5(NAMESPACE_URL, f"superdsh/studio/{scope}/{value}").hex


ASSET_VIEW = """
CREATE VIEW studio_assets AS
SELECT v.id, e.id AS family, e.owner_id AS owner, e.project_id AS project,
       v.origin_version_id AS parent,
       jsonb_build_object('kind', e.kind, 'name', v.name, 'description', v.description,
          'voice', v.voice_id, 'fileId', (SELECT a.file_id FROM studio_entity_version_assets r
             JOIN studio_asset_versions a ON a.id=r.asset_version_id
             WHERE r.entity_version_id=v.id ORDER BY r.position, r.asset_version_id LIMIT 1),
          'sourceJob', NULL, 'entityId', e.id, 'version', v.version_no) AS definition
FROM studio_entity_versions v JOIN studio_entities e ON e.id=v.entity_id
UNION ALL
SELECT v.id, f.id, f.owner_id, f.project_id, v.parent_version_id,
       jsonb_build_object('kind', f.kind, 'name', v.name, 'description', v.description,
          'voice', '', 'fileId', v.file_id, 'sourceJob', v.source_job_id, 'version', v.version_no)
FROM studio_asset_versions v JOIN studio_asset_families f ON f.id=v.family_id
"""


def insert(connection: sa.Connection, table: str, data: dict) -> None:
    """表名和列名仅来自冻结转换常量，值通过绑定参数传递。"""
    columns = ",".join(data)
    values = ",".join(f":{name}" for name in data)
    statement = sa.text(f"INSERT INTO {table} ({columns}) VALUES ({values})")
    for name, value in data.items():
        if isinstance(value, (dict, list)):
            statement = statement.bindparams(sa.bindparam(name, type_=sa.JSON))
    connection.execute(statement, data)


def migrate_assets(connection: sa.Connection) -> None:
    pending = {
        row["id"]: dict(row)
        for row in connection.execute(sa.text("SELECT * FROM studio_assets_legacy")).mappings()
    }
    completed: set[str] = set()
    counts: dict[str, int] = {}
    while pending:
        ready = [row for row in pending.values() if not row["parent"] or row["parent"] in completed]
        if not ready:
            raise RuntimeError("素材来源缺失或形成循环，迁移已回滚")
        for row in ready:
            definition = row["definition"]
            is_entity = definition["kind"] in {"character", "scene", "prop"}
            family = stable(row["project"] or row["owner"], row["family"])
            version = counts.get(family, 0) + 1
            counts[family] = version
            if version == 1:
                insert(
                    connection,
                    "studio_entities" if is_entity else "studio_asset_families",
                    {
                        "id": family,
                        "owner_id": row["owner"],
                        "project_id": row["project"],
                        "kind": definition["kind"],
                        "name": definition["name"],
                        "current_version_id": row["id"],
                        **({"revision": 1, "position": 0} if is_entity else {}),
                    },
                )
            else:
                table = "studio_entities" if is_entity else "studio_asset_families"
                connection.execute(
                    sa.text(f"UPDATE {table} SET current_version_id=:id WHERE id=:family"),
                    {"id": row["id"], "family": family},
                )
            if is_entity:
                insert(
                    connection,
                    "studio_entity_versions",
                    {
                        "id": row["id"],
                        "entity_id": family,
                        "version_no": version,
                        "origin_version_id": row["parent"],
                        "name": definition["name"],
                        "description": definition.get("description", ""),
                        "voice_id": definition.get("voice", ""),
                        "voice_parameters": {},
                    },
                )
                if file_id := definition.get("fileId"):
                    media_id = stable(row["id"], "reference")
                    insert(
                        connection,
                        "studio_asset_families",
                        {
                            "id": media_id,
                            "owner_id": row["owner"],
                            "project_id": row["project"],
                            "kind": "image",
                            "name": definition["name"],
                            "current_version_id": media_id,
                        },
                    )
                    insert(
                        connection,
                        "studio_asset_versions",
                        {
                            "id": media_id,
                            "family_id": media_id,
                            "version_no": 1,
                            "file_id": file_id,
                            "name": definition["name"],
                            "description": "",
                        },
                    )
                    insert(
                        connection,
                        "studio_entity_version_assets",
                        {
                            "entity_version_id": row["id"],
                            "asset_version_id": media_id,
                            "purpose": "reference",
                            "position": 0,
                        },
                    )
            else:
                insert(
                    connection,
                    "studio_asset_versions",
                    {
                        "id": row["id"],
                        "family_id": family,
                        "version_no": version,
                        "parent_version_id": row["parent"],
                        "file_id": definition.get("fileId"),
                        "name": definition["name"],
                        "description": definition.get("description", ""),
                        "source_job_id": definition.get("sourceJob"),
                    },
                )
            completed.add(row["id"])
            del pending[row["id"]]


def clone_entity(connection: sa.Connection, project: str, owner: str, source: dict) -> str:
    target = stable(project, source["id"])
    if connection.scalar(
        sa.text("SELECT id FROM studio_entity_versions WHERE id=:id"), {"id": target}
    ):
        return target
    family = stable(project, source["family"])
    existing = connection.scalar(
        sa.text("SELECT id FROM studio_entities WHERE id=:id"), {"id": family}
    )
    if not existing:
        insert(
            connection,
            "studio_entities",
            {
                "id": family,
                "owner_id": owner,
                "project_id": project,
                "kind": source["definition"]["kind"],
                "name": source["definition"]["name"],
                "current_version_id": target,
                "position": 0,
                "revision": 1,
            },
        )
    version = connection.scalar(
        sa.text(
            "SELECT coalesce(max(version_no),0)+1 FROM studio_entity_versions WHERE entity_id=:id"
        ),
        {"id": family},
    )
    connection.execute(
        sa.text("""INSERT INTO studio_entity_versions (id,entity_id,version_no,origin_version_id,name,description,voice_id,voice_parameters)
        SELECT :target,:family,:version,id,name,description,voice_id,voice_parameters FROM studio_entity_versions WHERE id=:source"""),
        {"target": target, "family": family, "version": version, "source": source["id"]},
    )
    connection.execute(
        sa.text("""INSERT INTO studio_entity_version_assets (entity_version_id,asset_version_id,purpose,position)
        SELECT :target,asset_version_id,purpose,position FROM studio_entity_version_assets WHERE entity_version_id=:source"""),
        {"target": target, "source": source["id"]},
    )
    return target


def migrate_projects(connection: sa.Connection) -> None:
    from migrations.data.studio_foundation_rows import project_rows

    if connection.scalar(
        sa.text(
            "SELECT count(*) FROM studio_projects p WHERE NOT EXISTS (SELECT 1 FROM studio_revisions r WHERE r.project=p.id AND r.revision=p.revision)"
        )
    ):
        raise RuntimeError("作品缺少当前修订，迁移已回滚")
    names = {
        "scenes": "studio_story_scenes",
        "shots": "studio_shots",
        "lines": "studio_lines",
        "references": "studio_shot_references",
        "media": "studio_project_assets",
        "entities": "studio_project_entity_versions",
        "clips": "studio_clips",
    }
    for work in connection.execute(
        sa.text(
            "SELECT p.*,r.document FROM studio_projects p JOIN studio_revisions r ON r.project=p.id AND r.revision=p.revision ORDER BY p.id"
        )
    ).mappings():
        doc = json.loads(json.dumps(work["document"]))
        catalog = {
            row["id"]: dict(row)
            for row in connection.execute(
                sa.text(
                    "SELECT * FROM studio_assets WHERE owner=:owner AND (project IS NULL OR project=:project)"
                ),
                {"owner": work["owner"], "project": work["id"]},
            ).mappings()
        }
        mapping = {}
        for source_id in doc.get("assets", []):
            if source_id not in catalog:
                raise RuntimeError(f"作品 {work['id']} 存在不可访问的素材，迁移已回滚")
            source = catalog[source_id]
            mapping[source_id] = (
                clone_entity(connection, work["id"], work["owner"], source)
                if source["project"] is None
                and source["definition"]["kind"] in {"character", "scene", "prop"}
                else source_id
            )
        doc["assets"] = list(dict.fromkeys(mapping.values()))
        shots = []
        for shot in doc.get("shots", []):
            value = {
                "scene": "",
                "sceneId": None,
                "camera": "",
                "framing": "",
                "movement": "",
                "duration": 5000,
                "references": [],
                "lines": [],
                "candidate": None,
                "trimStart": 0,
                "trimEnd": None,
                **shot,
            }
            value["references"] = [mapping[ref] for ref in value["references"]]
            value["lines"] = [
                SimpleNamespace(
                    **{
                        "voice": "",
                        "subtitle": None,
                        "subtitleStart": None,
                        "start": 0,
                        "end": None,
                        "audio": None,
                        "volume": 1,
                        **line,
                        "role": mapping[line["role"]],
                    }
                )
                for line in value["lines"]
            ]
            shots.append(SimpleNamespace(**value))
        document = SimpleNamespace(
            scenes=[],
            script=doc.get("script", ""),
            assets=doc["assets"],
            shots=shots,
            music=doc.get("music"),
            musicVolume=doc.get("musicVolume", 0.25),
        )
        kinds = {mapping.get(key, key): item["definition"]["kind"] for key, item in catalog.items()}
        jobs = {
            row["id"]: int(row["payload"].get("duration") or 0)
            for row in connection.execute(
                sa.text("SELECT id,payload FROM studio_media_jobs WHERE project=:project"),
                {"project": work["id"]},
            ).mappings()
        }
        rate = 48000
        rows = project_rows(work["id"], document, kinds, rate, jobs)
        insert(
            connection,
            "studio_scripts",
            {
                "project_id": work["id"],
                "source_text": document.script,
                "adaptation_mode": "original",
                "revision": 1,
            },
        )
        insert(
            connection,
            "studio_timelines",
            {
                "project_id": work["id"],
                "ticks_per_second": rate,
                "fps_num": 25,
                "fps_den": 1,
                "audio_sample_rate": 48000,
                "music_gain": document.musicVolume,
            },
        )
        for position, kind in enumerate(("video", "voice", "subtitle", "music")):
            insert(
                connection,
                "studio_tracks",
                {"project_id": work["id"], "id": kind, "kind": kind, "position": position},
            )
        for key, table in names.items():
            for row in rows[key]:
                if key == "clips":
                    row = {
                        "source_start_ticks": 0,
                        "gain": 1,
                        "timing_mode": "manual",
                        "anchor_offset_ticks": 0,
                        "subtitle_follow_voice": True,
                        **row,
                    }
                insert(connection, table, {"project_id": work["id"], **row})
        # 冻结旧规格与原文档；历史修订从未修改，也不重新提交任何媒体任务。
        manifest = {"document": doc, "legacy": True, "clock": [rate, 25, 1, 48000]}
        insert(
            connection,
            "studio_project_snapshots",
            {
                "project_id": work["id"],
                "project_revision": work["revision"],
                "manifest": manifest,
                "manifest_hash": hashlib.sha256(
                    json.dumps(manifest, sort_keys=True).encode()
                ).hexdigest(),
                "label": "保留迁移前工程",
            },
        )
