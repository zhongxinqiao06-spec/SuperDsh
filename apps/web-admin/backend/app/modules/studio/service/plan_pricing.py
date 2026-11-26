"""把制作服务已核验的模型绑定与执行输入映射为逐项报价，调用方无需传入点数。"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.billing.entity.vo.pricing import UsageItem
from app.modules.billing.service.quote_service import quote_in


async def quote_manifest(db: AsyncSession, owner: str, plan: str, manifest: dict) -> dict:
    selected = [i for i in manifest["items"] if i["selected"]]
    if manifest["issues"] or not selected:
        return manifest
    items = []
    for item in selected:
        payload = item["payload"]
        binding = payload["binding"]
        quantity = {
            "video": payload.get("seconds"),
            "speech": len(payload.get("text", "")),
            "image": 1,
        }[item["kind"]]
        # 当前制作适配器只接受服务端已授权的平台配置，个人凭据不能覆盖其承担方。
        items.append(
            UsageItem(
                product="entertainment",
                capability=binding["capability"],
                model=binding["configurationId"],
                model_revision=binding["revision"],
                spec=payload.get("resolution", "standard"),
                payer="platform",
                quantity=quantity,
                target=item["target"],
            )
        )
    quote = await quote_in(db, owner, "plan:" + plan, plan, items)
    return {**manifest, "usageQuote": quote}
