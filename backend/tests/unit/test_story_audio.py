from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from services.audio_preload import session_audio_plan
from services.story_audio import collect_story_audio_urls, story_audio_version


class _ScalarsResult:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items


def test_story_audio_version_is_deterministic_and_order_independent() -> None:
    urls = ["/audio/a.mp3", "/audio/b.mp3"]
    assert story_audio_version(urls) == story_audio_version(["/audio/a.mp3", "/audio/b.mp3"])
    # Состав отличается → версия другая.
    assert story_audio_version(urls) != story_audio_version(["/audio/a.mp3"])
    assert story_audio_version(urls).startswith("story-")


@pytest.mark.asyncio
async def test_collect_story_audio_urls_empty_for_no_stories() -> None:
    db = Mock()
    db.scalars = AsyncMock(return_value=_ScalarsResult([]))
    assert await collect_story_audio_urls(db, []) == []


@pytest.mark.asyncio
async def test_session_audio_plan_legacy_uses_global_manifest() -> None:
    # Не story-сессия: план = глобальный манифест ведущего, файлы с origin фронта.
    db = Mock()
    db.scalars = AsyncMock(return_value=_ScalarsResult([]))
    session = SimpleNamespace(id=uuid.uuid4(), story_id=None, settings={})

    plan = await session_audio_plan(db, session)

    assert plan["source"] == "manifest"
    assert plan["via_api"] is False
    assert isinstance(plan["audio_urls"], list)
    assert isinstance(plan["version"], str)


@pytest.mark.asyncio
async def test_session_audio_plan_story_engine_without_stories_falls_back() -> None:
    # use_story_engine, но активных сюжетов нет → fallback на глобальный манифест,
    # чтобы legacy-движок имел озвучку (см. session.story_id and use_story_engine).
    db = Mock()
    db.scalars = AsyncMock(return_value=_ScalarsResult([]))
    session = SimpleNamespace(
        id=uuid.uuid4(), story_id=None, settings={"use_story_engine": True}
    )

    plan = await session_audio_plan(db, session)

    assert plan["source"] == "manifest"
    assert plan["via_api"] is False
