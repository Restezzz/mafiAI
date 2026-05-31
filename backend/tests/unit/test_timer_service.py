from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock

import pytest

from services.timer_service import TimerService


@pytest.fixture
def ts():
    return TimerService()


@pytest.fixture
def sid():
    return uuid.uuid4()


@pytest.mark.asyncio
async def test_start_timer_fires_callback(ts, sid):
    called = asyncio.Event()

    async def cb():
        called.set()

    await ts.start_timer(sid, "test", 0, cb)
    await asyncio.sleep(0.05)
    assert called.is_set()


@pytest.mark.asyncio
async def test_has_timer_true_while_running(ts, sid):
    await ts.start_timer(sid, "test", 10, AsyncMock())
    assert ts.has_timer(sid, "test") is True
    await ts.cancel_timer(sid, "test")


@pytest.mark.asyncio
async def test_has_timer_false_when_none(ts, sid):
    assert ts.has_timer(sid, "test") is False


@pytest.mark.asyncio
async def test_cancel_timer_prevents_callback(ts, sid):
    called = False

    async def cb():
        nonlocal called
        called = True

    await ts.start_timer(sid, "test", 10, cb)
    await ts.cancel_timer(sid, "test")
    await asyncio.sleep(0.05)
    assert called is False


@pytest.mark.asyncio
async def test_cancel_timer_nonexistent_no_error(ts, sid):
    await ts.cancel_timer(sid, "nonexistent")


@pytest.mark.asyncio
async def test_cancel_all(ts, sid):
    c1 = asyncio.Event()
    c2 = asyncio.Event()

    await ts.start_timer(sid, "a", 10, c1.set)
    await ts.start_timer(sid, "b", 10, c2.set)
    await ts.cancel_all(sid)
    await asyncio.sleep(0.05)
    assert not c1.is_set()
    assert not c2.is_set()


@pytest.mark.asyncio
async def test_cancel_all_only_target_session(ts):
    s1 = uuid.uuid4()
    s2 = uuid.uuid4()
    called = asyncio.Event()

    await ts.start_timer(s1, "a", 10, AsyncMock())
    await ts.start_timer(s2, "b", 0, called.set)
    await ts.cancel_all(s1)
    await asyncio.sleep(0.05)
    assert called.is_set()


@pytest.mark.asyncio
async def test_has_timer_false_after_cancel(ts, sid):
    await ts.start_timer(sid, "test", 10, AsyncMock())
    await ts.cancel_timer(sid, "test")
    assert ts.has_timer(sid, "test") is False


@pytest.mark.asyncio
async def test_has_timer_false_after_completion(ts, sid):
    await ts.start_timer(sid, "test", 0, AsyncMock())
    await asyncio.sleep(0.05)
    assert ts.has_timer(sid, "test") is False


@pytest.mark.asyncio
async def test_start_timer_replaces_previous(ts, sid):
    c1 = asyncio.Event()
    c2 = asyncio.Event()

    await ts.start_timer(sid, "test", 10, c1.set)
    await ts.start_timer(sid, "test", 0, c2.set)
    await asyncio.sleep(0.05)
    assert not c1.is_set()
    assert c2.is_set()


@pytest.mark.asyncio
async def test_callback_self_cancel_does_not_abort(ts, sid):
    """Регрессия: resolver вызывает cancel_timer своего же таймера изнутри
    callback'а (как resume_game → resolve_story_vote → cancel_timer). Раньше это
    отменяло текущую задачу и CancelledError рвал следующий await — переход
    фазы не доходил до конца. cancel_timer не должен отменять текущую задачу."""
    finished = False

    async def cb():
        nonlocal finished
        # resolver чистит свой таймер...
        await ts.cancel_timer(sid, "test")
        # ...и продолжает работу (имитация db.commit() после cancel_timer)
        await asyncio.sleep(0.01)
        finished = True

    await ts.start_timer(sid, "test", 0, cb)
    await asyncio.sleep(0.1)
    assert finished is True
    assert ts.has_timer(sid, "test") is False


@pytest.mark.asyncio
async def test_callback_restart_same_name_timer_survives(ts, sid):
    """callback отменяет свой таймер и запускает новый с тем же именем —
    finally старой задачи не должно убирать новый таймер из реестра."""
    async def cb():
        await ts.cancel_timer(sid, "test")
        await ts.start_timer(sid, "test", 10, AsyncMock())

    await ts.start_timer(sid, "test", 0, cb)
    await asyncio.sleep(0.05)
    assert ts.has_timer(sid, "test") is True
    await ts.cancel_timer(sid, "test")
