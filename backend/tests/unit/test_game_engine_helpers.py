from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from services.game_engine import (
    _begin_phase_transition,
    _end_phase_transition,
    _is_turn_enabled,
    _role_config,
    check_win_condition,
    doctor_self_heal_used,
)
from services.runtime_state import runtime_state


def test_role_config_with_settings():
    session = SimpleNamespace(settings={"role_config": {"mafia": 2}})
    assert _role_config(session) == {"mafia": 2}


def test_role_config_none_settings():
    session = SimpleNamespace(settings=None)
    assert _role_config(session) == {}


def test_role_config_empty_settings():
    session = SimpleNamespace(settings={})
    assert _role_config(session) == {}


@pytest.mark.parametrize("slug,key,count,expected", [
    ("mafia", "mafia", 2, True),
    ("mafia", "mafia", 0, False),
    ("don", "don", 1, True),
    ("don", "don", 0, False),
    ("sheriff", "sheriff", 1, True),
    ("doctor", "doctor", 1, True),
    ("lover", "lover", 1, True),
    ("maniac", "maniac", 1, True),
    ("maniac", "maniac", 0, False),
])
def test_is_turn_enabled(slug, key, count, expected):
    session = SimpleNamespace(settings={"role_config": {key: count}})
    assert _is_turn_enabled(session, slug) == expected


def test_begin_end_phase_transition():
    sid = uuid.uuid4()
    rt = runtime_state.get(sid)
    rt.phase_transition_depth = 0
    rt.phase_transition_running = False

    _begin_phase_transition(sid)
    assert rt.phase_transition_depth == 1
    assert rt.phase_transition_running is True

    _end_phase_transition(sid)
    assert rt.phase_transition_depth == 0
    assert rt.phase_transition_running is False

    runtime_state.clear(sid)


def test_nested_phase_transition():
    sid = uuid.uuid4()
    rt = runtime_state.get(sid)
    rt.phase_transition_depth = 0
    rt.phase_transition_running = False

    _begin_phase_transition(sid)
    _begin_phase_transition(sid)
    assert rt.phase_transition_depth == 2

    _end_phase_transition(sid)
    assert rt.phase_transition_depth == 1
    assert rt.phase_transition_running is True

    _end_phase_transition(sid)
    assert rt.phase_transition_depth == 0
    assert rt.phase_transition_running is False

    runtime_state.clear(sid)


# --- check_win_condition ---


def _fake_player(**kwargs):
    defaults = dict(id=uuid.uuid4(), session_id=uuid.uuid4(), user_id=uuid.uuid4(), role_id=None, role=None, status="alive", name="Player")
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _fake_role(**kwargs):
    defaults = dict(id=uuid.uuid4(), slug="civilian", name="Мирный", team="city", abilities={})
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


class ScalarsResult:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items


@pytest.mark.asyncio
async def test_check_win_city_wins():
    city_role = _fake_role(slug="civilian", team="city")
    # selectinload(Player.role) подгружает role в один запрос — игроки уже имеют .role
    p1 = _fake_player(role_id=city_role.id, role=city_role, status="alive")
    p2 = _fake_player(role_id=city_role.id, role=city_role, status="alive")

    db = Mock()
    db.scalars = AsyncMock(return_value=ScalarsResult([p1, p2]))

    result = await check_win_condition(db, uuid.uuid4())
    assert result == "city"


@pytest.mark.asyncio
async def test_check_win_mafia_wins():
    mafia_role = _fake_role(slug="mafia", team="mafia")
    city_role = _fake_role(slug="civilian", team="city")
    p1 = _fake_player(role_id=mafia_role.id, role=mafia_role, status="alive")
    p2 = _fake_player(role_id=city_role.id, role=city_role, status="alive")

    db = Mock()
    db.scalars = AsyncMock(return_value=ScalarsResult([p1, p2]))

    result = await check_win_condition(db, uuid.uuid4())
    assert result == "mafia"


@pytest.mark.asyncio
async def test_check_win_game_continues():
    mafia_role = _fake_role(slug="mafia", team="mafia")
    city_role = _fake_role(slug="civilian", team="city")
    p1 = _fake_player(role_id=mafia_role.id, role=mafia_role, status="alive")
    p2 = _fake_player(role_id=city_role.id, role=city_role, status="alive")
    p3 = _fake_player(role_id=city_role.id, role=city_role, status="alive")

    db = Mock()
    db.scalars = AsyncMock(return_value=ScalarsResult([p1, p2, p3]))

    result = await check_win_condition(db, uuid.uuid4())
    assert result is None


@pytest.mark.asyncio
async def test_check_win_no_alive_players():
    db = Mock()
    db.scalars = AsyncMock(return_value=ScalarsResult([]))

    result = await check_win_condition(db, uuid.uuid4())
    assert result is None


# --- doctor_self_heal_used ---


@pytest.mark.asyncio
async def test_doctor_self_heal_used_true():
    # Найдена прошлая запись heal на себя → доктор уже лечил себя.
    db = Mock()
    db.scalar = AsyncMock(return_value=uuid.uuid4())

    assert await doctor_self_heal_used(db, uuid.uuid4(), uuid.uuid4()) is True


@pytest.mark.asyncio
async def test_doctor_self_heal_used_false():
    # Нет ни одной записи heal на себя → лечить себя ещё можно.
    db = Mock()
    db.scalar = AsyncMock(return_value=None)

    assert await doctor_self_heal_used(db, uuid.uuid4(), uuid.uuid4()) is False
