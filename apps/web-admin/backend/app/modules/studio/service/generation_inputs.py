"""制作前统一解析可用模型、音色和参考文件；不持有写事务、不发起收费调用。"""

import io
import math
from typing import TYPE_CHECKING, Any, cast

from PIL import Image, UnidentifiedImageError

from app.infrastructure.errors import DomainError
from app.modules.identity.entity.bo.models import Account
from app.modules.models.entity.vo.model_vo import CapabilityBinding
from app.modules.studio.service.bailian_media import BailianMedia

if TYPE_CHECKING:
    from app.modules.studio.service.media_jobs import MediaJobs


class GenerationInputs:
    def __init__(self, media: "MediaJobs", account: Account, catalog: dict) -> None:
        self.media, self.account, self.catalog = media, account, catalog
        self.resolved: dict[str, dict] = {}
        self.checked_images: set[str] = set()

    async def model(
        self,
        capability: str,
        choice: str | None = None,
        binding: dict | None = None,
        reference: bool | None = None,
    ) -> tuple[dict, dict]:
        """尊重显式选择和冻结角色声音绑定，不自动换供应商或已停用配置。"""
        chosen = (
            choice
            or (binding or {}).get("configurationId")
            or next(
                (
                    d["configurationId"]
                    for d in self.catalog["defaults"]
                    if d["capability"] == capability
                ),
                None,
            )
        )
        eligible = [
            c
            for c in self.catalog["configurations"]
            if c["capability"] == capability
            and (
                reference is None or (c["parameters"].get("inputMode") == "reference") == reference
            )
        ]
        config = next((c for c in eligible if c["id"] == chosen), None)
        if not config and not choice and not binding and reference is not None:
            config = next(iter(eligible), None)
        if not config:
            raise DomainError(
                422, "缺少当前产品可用的" + capability + "配置，或所选模型不支持此输入"
            )
        frozen = (
            binding
            if binding and not choice
            else {
                "configurationId": config["id"],
                "revision": config["revision"],
                "capability": capability,
            }
        )
        key = str(frozen)
        if key not in self.resolved:
            self.resolved[key] = cast(
                dict[str, Any],
                await self.media.models.resolve(
                    self.account, CapabilityBinding.model_validate(frozen), "entertainment"
                ),
            )
        return frozen, self.resolved[key]

    async def images(self, values: list[str], limit: int) -> list[str]:
        unique = list(dict.fromkeys(values))
        if len(unique) > limit:
            raise DomainError(422, "参考图数量超过模型允许范围")
        for identity in unique:
            if identity in self.checked_images:
                continue
            entry = await self.media.studio.files.entry(self.account, identity)
            if (
                entry["mediaType"] not in {"image/png", "image/jpeg", "image/webp"}
                or int(str(entry["size"])) > 20 * 1024 * 1024
            ):
                raise DomainError(422, "参考图必须为不超过 20 MB 的 PNG/JPEG/WebP 文件")
            content, _ = await self.media.studio.files.read(self.account, identity)
            if not content:
                raise DomainError(422, "参考文件不可读取")
            try:
                with Image.open(io.BytesIO(content)) as picture:
                    picture.verify()
            except (OSError, ValueError, UnidentifiedImageError):
                raise DomainError(422, "参考图片内容损坏，请重新上传") from None
            self.checked_images.add(identity)
        return unique

    async def speech(
        self, text: str, voice: str, choice: str | None, binding: dict | None = None
    ) -> dict:
        selected, resolved = await self.model("speech.synthesize", choice, binding)
        BailianMedia(
            self.media.models.transport,
            resolved["connection"]["baseUrl"],
            resolved["apiKey"],
            resolved["configuration"]["modelId"],
        )
        if not text.strip() or voice not in resolved["configuration"]["parameters"].get(
            "voices", ""
        ).split(","):
            raise DomainError(422, "台词为空或角色音色不属于所选配音模型，请先试听并采用音色")
        return {
            "text": text,
            "voice": voice,
            "binding": selected,
            "modelName": resolved["configuration"]["name"],
        }

    async def video(self, shot: dict, assets: dict, intent: dict, brief: dict) -> dict:
        refs = [
            assets[identity]
            for identity in dict.fromkeys(
                [*shot["references"], *(line["role"] for line in shot["lines"])]
            )
        ]
        images = await self.images(
            [
                a["fileId"]
                for a in refs
                if a.get("fileId") and a["kind"] in {"character", "scene", "prop", "image"}
            ],
            9,
        )
        selected, resolved = await self.model(
            "video.generate",
            intent.get("referenceVideo") if images else intent.get("video"),
            reference=bool(images),
        )
        BailianMedia(
            self.media.models.transport,
            resolved["connection"]["baseUrl"],
            resolved["apiKey"],
            resolved["configuration"]["modelId"],
        )
        seconds = math.ceil(shot["duration"] / 1000)
        if not 3 <= seconds <= 15 or not shot["action"].strip():
            raise DomainError(422, "请补充动作描述，单镜生成时长须在 3 到 15 秒")
        aspect = (
            f"{brief['aspectWidth']}:{brief['aspectHeight']}"
            if brief.get("aspectWidth")
            else "16:9"
        )
        if aspect not in {"16:9", "9:16", "1:1", "4:3", "3:4"}:
            raise DomainError(422, "当前视频适配不支持作品画幅，请调整规格后再确认")
        # 图片按去重后的实际发送顺序标识，角色与场景共用文件时不能错指下一张图。
        reference_labels = [
            f"参考图 [Image {index}] 中的主体："
            + "、".join(dict.fromkeys(a["name"] for a in refs if a.get("fileId") == image))
            + "。沿用主体外观，背景按本镜场景设定。"
            for index, image in enumerate(images, 1)
        ]
        prompt = "\n".join(
            filter(
                None,
                [
                    brief.get("styleBrief", ""),
                    shot["scene"],
                    shot["action"],
                    shot["framing"],
                    shot["camera"],
                    shot["movement"],
                    *reference_labels,
                    *[f"{a['name']}：{a.get('description', '')}" for a in refs],
                ],
            )
        )
        return {
            "prompt": prompt,
            "images": images,
            "seconds": seconds,
            "duration": seconds * 1000,
            "binding": selected,
            "modelName": resolved["configuration"]["name"],
            "aspect": aspect,
            "resolution": "720P",
        }

    async def reference(self, asset: dict, intent: dict) -> dict:
        binding, resolved = await self.model("image.generate", intent.get("configuration"))
        images = await self.images(
            [asset["fileId"]] if intent.get("useReference") and asset.get("fileId") else [],
            resolved["configuration"]["parameters"].get("maxImages", 1),
        )
        if images and resolved["connection"]["adapter"] != "volcengine-ark":
            raise DomainError(422, "当前模型不支持参考图编辑，可取消沿用参考或另选模型")
        return {
            "prompt": "\n".join(
                [asset["name"], asset.get("description", ""), intent.get("prompt", "")]
            ),
            "images": images,
            "binding": binding,
            "modelName": resolved["configuration"]["name"],
        }
