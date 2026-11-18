"""素材菜单升级保留自定义与授权，重复升级不改变排序。"""

from migrations.data.studio_library_navigation import library_navigation_items


def test_split_library_preserves_restrictions_and_identity() -> None:
    source: list[dict[str, object]] = [
        {
            "id": "private-group",
            "kind": "group",
            "moduleId": None,
            "parentId": None,
            "title": "私有素材",
            "icon": "book-open",
            "order": 0,
            "visible": False,
            "roleIds": ["admin"],
        },
        {
            "id": "environment-custom",
            "kind": "page",
            "moduleId": "studio.environments",
            "parentId": "private-group",
            "title": "场景与道具",
            "icon": "book-open",
            "order": 5,
            "visible": False,
            "roleIds": ["entertainment_admin"],
        },
        {
            "id": "media",
            "kind": "page",
            "moduleId": "studio.library",
            "parentId": "private-group",
            "title": "我收藏的片段",
            "icon": "book-open",
            "order": 6,
            "visible": True,
            "roleIds": [],
        },
        {
            "id": "studio.props",
            "kind": "group",
            "moduleId": None,
            "parentId": None,
            "title": "自定义组",
            "icon": "folder",
            "order": 9,
            "visible": True,
            "roleIds": [],
        },
    ]
    result = library_navigation_items(source)
    props = next(item for item in result if item.get("moduleId") == "studio.props")
    assert props["id"] == "studio.props-new"
    assert props["parentId"] == "private-group"
    assert props["roleIds"] == ["entertainment_admin"]
    assert props["visible"] is False
    assert props["order"] == 6
    assert result[1]["title"] == "场景库"
    assert result[2]["title"] == "我收藏的片段"
    assert result[2]["order"] == 7
    assert source[2]["order"] == 6
    assert library_navigation_items(result) == result


def test_removed_environment_menu_is_not_restored_elsewhere() -> None:
    assert library_navigation_items([]) == []
