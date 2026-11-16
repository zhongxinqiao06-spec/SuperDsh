"""生成依赖摘要只包含实际输入，排除排队状态和操作号；不以镜头序号寻址。"""

from app.modules.studio.entity.bo.foundation import content_hash

ACTIVE = {"queued", "submitting", "polling", "downloading"}
UNCERTAIN = {"unknown", "paused", "unaccepted"}


def input_hash(kind: str, payload: dict) -> str:
    fields = (
        ("text", "voice", "binding")
        if kind == "speech"
        else ("prompt", "images", "seconds", "binding", "aspect", "resolution")
    )
    return content_hash({"kind": kind, **{key: payload.get(key) for key in fields}})


def candidate_state(kind: str, subject: str, payload: dict, jobs: list) -> dict:
    relevant = [
        job
        for job in jobs
        if job.kind == kind and job.subject == subject and not job.payload.get("purpose")
    ]
    matches = [
        job
        for job in relevant
        if (job.payload.get("inputHash") or input_hash(kind, job.payload))
        == input_hash(kind, payload)
    ]
    ambiguous = next(
        (
            job
            for job in relevant
            if job.state in UNCERTAIN and not job.payload.get("replacementPlan")
        ),
        None,
    )
    active = next((job for job in matches if job.state in ACTIVE), None)
    ready = next((job for job in matches if job.state == "ready"), None)
    latest = matches[0] if matches else None
    state = (
        "uncertain"
        if ambiguous
        else "active"
        if active
        else "recoverable"
        if latest and latest.state == "failed" and latest.payload.get("recoveryState")
        else "failed"
        if latest and latest.state == "failed"
        else "ready"
        if ready
        else "outdated"
        if relevant
        else "missing"
    )
    chosen = ambiguous or active or ready or latest or (relevant[0] if relevant else None)
    return {"status": state, "job": chosen.id if chosen else None}
