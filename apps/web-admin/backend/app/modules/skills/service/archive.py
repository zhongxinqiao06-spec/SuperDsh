"""资料技能归档不携带可执行代码，引用文件必须经资产服务授权保存。"""

import hashlib
import re
from pathlib import PurePosixPath

import yaml
from yaml.nodes import MappingNode

from app.infrastructure.errors import DomainError
from app.modules.extensions.service.archive import read_archive


class SkillYamlLoader(yaml.SafeLoader):
    """禁止别名及重复键，避免元数据通过解析歧义改变权限声明。"""

    def compose_node(self, parent: yaml.Node | None, index: int) -> yaml.Node | None:
        if self.check_event(yaml.AliasEvent):
            raise DomainError(422, "技能元数据不允许YAML别名")
        return super().compose_node(parent, index)

    def construct_mapping(self, node: MappingNode, deep: bool = False) -> dict[object, object]:
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        if len(keys) != len({str(key) for key in keys}):
            raise DomainError(422, "技能元数据包含重复键")
        return super().construct_mapping(node, deep=deep)


def read_skill(data: bytes) -> tuple[dict[str, object], dict[str, bytes]]:
    """检查ZIP及SKILL.md frontmatter，返回定义与待事务保存的引用。"""
    if not data or len(data) > 12 * 1024 * 1024:
        raise DomainError(413, "技能ZIP最多12MiB")
    files = read_archive(data, max_files=100, max_bytes=24 * 1024 * 1024, per_file=4 * 1024 * 1024)
    for name in files:
        if PurePosixPath(name).suffix.lower() not in {
            ".md",
            ".txt",
            ".csv",
            ".xlsx",
            ".docx",
            ".pptx",
            ".pdf",
        }:
            raise DomainError(422, "技能只能包含资料，执行脚本必须安装为独立工具")
        if name.lower().endswith(".pptx") and not name.startswith("templates/"):
            raise DomainError(422, "PPTX模板必须放在templates目录")
    try:
        markdown = files.pop("SKILL.md").decode("utf-8")
        match = re.fullmatch(r"---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)", markdown)
        if match is None:
            raise ValueError("frontmatter missing")
        metadata = yaml.load(match[1], Loader=SkillYamlLoader)
        if not isinstance(metadata, dict):
            raise ValueError("metadata invalid")
        for key, limit in (("name", 100), ("description", 1000)):
            if (
                not isinstance(metadata.get(key), str)
                or not 1 <= len(metadata[key].strip()) <= limit
            ):
                raise ValueError("metadata invalid")
        instructions = match[2].strip()
        if not 1 <= len(instructions) <= 12000:
            raise ValueError("instructions invalid")
    except (KeyError, UnicodeError, ValueError, yaml.YAMLError) as error:
        raise DomainError(422, "SKILL.md需要有效的name、description元数据和执行指令") from error
    return {
        "name": metadata["name"],
        "description": metadata["description"],
        "instructions": instructions,
        "requiredToolIds": metadata.get("requiredToolIds", []),
        "packageSha256": hashlib.sha256(data).hexdigest(),
    }, files
