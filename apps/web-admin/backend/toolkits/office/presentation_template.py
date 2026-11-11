"""PPT模板检查、页面克隆和具名文本映射，保留母版、图片和图表关系。"""

import copy
import io

from defusedxml import ElementTree
from pptx import Presentation
from pptx.presentation import Presentation as PresentationType
from pptx.shapes.autoshape import Shape
from pptx.slide import Slide

from app.infrastructure.errors import DomainError
from toolkits.office.contracts import InputFile, office_archive

RELATIONSHIP_NAMESPACE = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def load_template(file: InputFile) -> PresentationType:
    """明确拒绝不能保持行为的动画、组合和活动对象，而非静默丢弃。"""
    parts = office_archive(file)
    if not file.filename.lower().endswith(".pptx"):
        raise DomainError(422, "演示模板必须为PPTX")
    for name, content in parts.items():
        if (
            name.startswith("ppt/slides/")
            and name.endswith(".xml")
            and any(
                node.tag.split("}")[-1] in {"timing", "grpSp", "videoFile", "audioFile"}
                for node in ElementTree.fromstring(content).iter()
            )
        ):
            raise DomainError(422, "模板包含动画、组合或音视频，请先拆解")
    try:
        presentation = Presentation(io.BytesIO(file.content))
    except (ValueError, KeyError, OSError) as error:
        raise DomainError(422, "PPT模板损坏") from error
    if (
        not 1 <= len(presentation.slides) <= 20
        or presentation.slide_width is None
        or presentation.slide_height is None
        or not 0 < presentation.slide_width.inches <= 40
        or not 0 < presentation.slide_height.inches <= 40
    ):
        raise DomainError(422, "模板页数或页面大小超限")
    for slide in presentation.slides:
        names = [shape.name for shape in slide.shapes]
        if len(names) != len(set(names)):
            raise DomainError(422, "模板形状名称重复，无法准确映射")
    return presentation


def inspect_template(file: InputFile) -> dict[str, object]:
    """对外展示可映射的形状名称与英寸区域，不泄露归档内部路径。"""
    presentation = load_template(file)
    assert presentation.slide_width is not None and presentation.slide_height is not None
    return {
        "filename": file.filename,
        "sha256": file.sha256,
        "width": presentation.slide_width.inches,
        "height": presentation.slide_height.inches,
        "slides": [
            {
                "number": index,
                "shapes": [
                    {
                        "name": shape.name,
                        "text": shape.text
                        if isinstance(shape, Shape) and shape.has_text_frame
                        else "",
                        "region": {
                            "x": shape.left.inches,
                            "y": shape.top.inches,
                            "w": shape.width.inches,
                            "h": shape.height.inches,
                        },
                        "role": "title"
                        if shape == slide.shapes.title
                        else "body"
                        if shape.is_placeholder
                        else None,
                    }
                    for shape in slide.shapes
                ],
            }
            for index, slide in enumerate(presentation.slides, 1)
        ],
    }


def clone_slide(presentation: PresentationType, source: Slide) -> Slide:
    """在同一包内克隆页面并重映射关系ID，图表和媒体不变成无效外链。"""
    target = presentation.slides.add_slide(source.slide_layout)
    for shape in list(target.shapes):
        target.shapes._spTree.remove(shape.element)
    mapping: dict[str, str] = {}
    for relationship in source.part.rels.values():
        if relationship.reltype.endswith(("/slideLayout", "/notesSlide")):
            continue
        mapping[relationship.rId] = (
            target.part.rels.get_or_add_ext_rel(relationship.reltype, relationship.target_ref)
            if relationship.is_external
            else target.part.rels.get_or_add(relationship.reltype, relationship.target_part)
        )
    for shape in source.shapes:
        element = copy.deepcopy(shape.element)
        for node in element.iter():
            for name, value in tuple(node.attrib.items()):
                if name.startswith(RELATIONSHIP_NAMESPACE) and value in mapping:
                    node.set(name, mapping[value])
        target.shapes._spTree.insert_element_before(element, "p:extLst")
    background = source.element.cSld.bg
    if background is not None:
        target.element.cSld.insert(0, copy.deepcopy(background))
    return target


def find_text(slide: Slide, name: object, title: bool = False) -> Shape | None:
    """显式名称必须命中可编辑文本；缺省标题采用模板标题占位符。"""
    selected = (
        next((shape for shape in slide.shapes if shape.name == name), None)
        if name
        else slide.shapes.title
        if title
        else None
    )
    if selected is not None and isinstance(selected, Shape) and selected.has_text_frame:
        return selected
    if name:
        raise DomainError(422, "模板映射的文本框不存在")
    return None
