"""阶段状态由内容与确认指纹计算，修订号变化不等于所有阶段失效。"""

from app.modules.studio.entity.bo.foundation import content_hash

STAGES = {
    "script": "剧本与场次",
    "cast": "角色与场景",
    "storyboard": "分镜设计",
    "sample": "试做一镜",
}


def preparation_inputs(document: dict, assets: list[dict], jobs: list[dict], brief: dict) -> dict:
    linked = sorted(
        [
            a
            for a in assets
            if a["id"] in document["assets"] and a["kind"] in {"character", "scene", "prop"}
        ],
        key=lambda asset: asset["id"],
    )
    script = {
        "script": document["script"],
        "mode": document.get("adaptationMode", "original"),
        "scenes": [
            {
                key: value
                for key, value in scene.items()
                if key != "sceneAssetId" or value is not None
            }
            for scene in document.get("scenes", [])
        ],
    }
    cast = {"script": content_hash(script), "entities": linked}
    shots = [
        {
            key: value
            for key, value in shot.items()
            if key not in {"candidate", "videoAssetId", "trimStart", "trimEnd", "lines"}
            and (key != "sceneAssetId" or value is not None)
        }
        | {
            "lines": [
                {k: v for k, v in line.items() if k in {"id", "role", "text", "voice"}}
                for line in shot["lines"]
            ]
        }
        for shot in document["shots"]
    ]
    board = {
        "cast": content_hash(cast),
        "shots": shots,
        "style": brief.get("styleBrief"),
        "aspect": [brief.get("aspectWidth"), brief.get("aspectHeight")],
    }
    sample = {
        "storyboard": content_hash(board),
        "candidates": [
            (
                s["id"],
                {"assetVersion": s["videoAssetId"]}
                if s.get("videoAssetId")
                else s.get("candidate"),
            )
            for s in document["shots"]
        ],
    }
    return {"script": script, "cast": cast, "storyboard": board, "sample": sample}


def preparation_issues(
    document: dict, assets: list[dict], jobs: list[dict]
) -> dict[str, list[dict]]:
    issues: dict[str, list[dict]] = {stage: [] for stage in STAGES}

    def issue(
        stage: str, key: str, message: str, target: str | None = None, waivable: bool = False
    ) -> None:
        issues[stage].append(
            {"key": key, "message": message, "target": target, "waivable": waivable}
        )

    if not document["script"].strip():
        issue("script", "script.empty", "先填写剧本，或请导演根据故事构想起草。")
    linked = {a["id"]: a for a in assets if a["id"] in document["assets"]}
    spoken = {line["role"] for shot in document["shots"] for line in shot["lines"] if line["text"]}
    ready = {job["id"] for job in jobs if job["state"] == "ready"}
    for asset in linked.values():
        if asset["kind"] not in {"character", "scene", "prop"}:
            continue
        if not asset.get("fileId"):
            issue(
                "cast",
                "reference:" + asset["id"],
                asset["name"] + "还没有造型或场景参考图",
                asset["id"],
                True,
            )
        if asset["id"] in spoken and (
            not asset.get("voice")
            or not asset.get("voiceBinding")
            or asset.get("voicePreviewJob") not in ready
        ):
            issue(
                "cast",
                "voice:" + asset["id"],
                asset["name"] + "还未试听并采用本片音色",
                asset["id"],
                True,
            )
    if not document["shots"]:
        issue("storyboard", "shots.empty", "先添加分镜，或审阅导演提交的镜头草案。")
        issue("sample", "shots.empty", "先完成分镜，再选择代表镜头试做。")
    for index, shot in enumerate(document["shots"], 1):
        if not shot["action"].strip():
            issue("storyboard", "action:" + shot["id"], f"第 {index} 镜缺少动作描述", shot["id"])
        scene: dict = next(
            (s for s in document.get("scenes", []) if s["id"] == shot.get("sceneId")), {}
        )
        scene_asset = shot.get("sceneAssetId") or scene.get("sceneAssetId")
        if not any(linked.get(ref, {}).get("fileId") for ref in [*shot["references"], scene_asset]):
            issue(
                "storyboard",
                "board:" + shot["id"],
                f"第 {index} 镜没有分镜参考画面，可先生成或明确略过",
                shot["id"],
                True,
            )
    return issues
