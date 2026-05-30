from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from services.audio_preload import session_audio_plan
from services.story_audio import (
    collect_story_audio_urls,
    story_audio_version,
    variant_index_for_cue,
)


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


def test_variant_index_for_cue_is_stable_and_bounded() -> None:
    sid = uuid.uuid4()
    cid = uuid.uuid4()
    # Детерминированно: один и тот же (session, cue) → один индекс.
    assert variant_index_for_cue(sid, cid, 5) == variant_index_for_cue(sid, cid, 5)
    # В границах [0, n).
    for n in (1, 2, 7, 13):
        assert 0 <= variant_index_for_cue(sid, cid, n) < n
    # Без session_id или пустой набор → 0.
    assert variant_index_for_cue(None, cid, 5) == 0
    assert variant_index_for_cue(sid, cid, 0) == 0


@pytest.mark.asyncio
async def test_collect_story_audio_urls_scopes_to_single_variant_per_cue() -> None:
    # С session_id для каждой cue берётся РОВНО один вариант триггера (тот, что
    # реально прозвучит), а не все варианты — раньше это раздувало набор.
    story_id = uuid.uuid4()
    session_id = uuid.uuid4()
    cue_id = uuid.uuid4()

    def _variant(path: str):
        return SimpleNamespace(
            id=uuid.uuid4(), audio_file=SimpleNamespace(storage_path=path)
        )

    variants = [_variant(f"v{i}.mp3") for i in range(4)]
    trigger = SimpleNamespace(id=uuid.uuid4(), variants=variants)
    cue = SimpleNamespace(id=cue_id, trigger=trigger)

    # collect делает 3 запроса: cues, names, name-variant-assets.
    db = Mock()
    db.scalars = AsyncMock(
        side_effect=[
            _ScalarsResult([cue]),  # cues
            _ScalarsResult([]),  # names
            _ScalarsResult([]),  # variant assets
        ]
    )

    urls = await collect_story_audio_urls(db, [story_id], session_id=session_id)

    assert len(urls) == 1
    # Это именно тот вариант, который выберет воспроизведение.
    chosen = sorted(variants, key=lambda v: str(v.id))[
        variant_index_for_cue(session_id, cue_id, len(variants))
    ]
    assert urls == [f"/audio/{chosen.audio_file.storage_path}"]


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
