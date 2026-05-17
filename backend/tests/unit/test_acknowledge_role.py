from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy.exc import IntegrityError

from core.exceptions import GameError
from models.player import Player
from models.session import Session
from services import game_engine


def _make_session() -> Session:
    return Session(id=uuid.uuid4(), status="active")


def _make_player() -> Player:
    return Player(id=uuid.uuid4(), session_id=uuid.uuid4(), user_id=uuid.uuid4(), status="alive", name="P1")


@pytest.mark.asyncio
async def test_acknowledge_role_returns_counts_and_broadcasts_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _make_session()
    player = _make_player()
    phase = SimpleNamespace(id=uuid.uuid4(), phase_type="role_reveal")

    db = Mock()
    # Порядок scalar()-ов после рефакторинга: alive_total, acked, pending_alive.
    # SELECT-then-INSERT удалён (см. #3, partial unique index).
    db.scalar = AsyncMock(side_effect=[5, 1, 4])
    db.commit = AsyncMock()
    db.add = Mock()

    send_to_session = AsyncMock()

    monkeypatch.setattr(game_engine, "get_current_phase", AsyncMock(return_value=phase))
    monkeypatch.setattr(game_engine.ws_manager, "send_to_session", send_to_session)

    result = await game_engine.acknowledge_role(db, session, player)

    assert result == {"acknowledged": True, "players_acknowledged": 1, "players_total": 5}
    send_to_session.assert_awaited_once_with(
        session.id,
        {
            "type": "role_acknowledged",
            "payload": {
                "player_id": str(player.id),
                "players_acknowledged": 1,
                "players_total": 5,
            },
        },
    )


@pytest.mark.asyncio
async def test_acknowledge_role_starts_night_when_everyone_is_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _make_session()
    player = _make_player()
    phase = SimpleNamespace(id=uuid.uuid4(), phase_type="role_reveal")

    db = Mock()
    # Порядок scalar()-ов: alive_total=5, acked=5, pending_alive=0 (все ack'нули).
    db.scalar = AsyncMock(side_effect=[5, 5, 0])
    db.commit = AsyncMock()
    db.add = Mock()

    send_to_session = AsyncMock()
    cancel_timer = AsyncMock()
    spawned: list[object] = []

    def fake_create_task(coro):
        spawned.append(coro)
        coro.close()
        return Mock()

    monkeypatch.setattr(game_engine, "get_current_phase", AsyncMock(return_value=phase))
    monkeypatch.setattr(game_engine.ws_manager, "send_to_session", send_to_session)
    monkeypatch.setattr(game_engine.timer_service, "cancel_timer", cancel_timer)
    monkeypatch.setattr(game_engine.asyncio, "create_task", fake_create_task)

    result = await game_engine.acknowledge_role(db, session, player)

    assert result == {"acknowledged": True, "players_acknowledged": 5, "players_total": 5}
    assert send_to_session.await_args_list[0].args == (
        session.id,
        {
            "type": "role_acknowledged",
            "payload": {
                "player_id": str(player.id),
                "players_acknowledged": 5,
                "players_total": 5,
            },
        },
    )
    assert send_to_session.await_args_list[1].args == (
        session.id,
        {"type": "all_acknowledged", "payload": {}},
    )
    cancel_timer.assert_awaited_once_with(session.id, "role_reveal")
    assert len(spawned) == 1


@pytest.mark.asyncio
async def test_acknowledge_role_rejects_duplicate_ack(monkeypatch: pytest.MonkeyPatch) -> None:
    """После рефакторинга #3 дедуп ловится через IntegrityError от partial
    unique index uq_role_ack_session_phase_player, не через предварительный
    SELECT.
    """
    session = _make_session()
    player = _make_player()
    phase = SimpleNamespace(id=uuid.uuid4(), phase_type="role_reveal")

    db = Mock()
    # Первый commit падает с IntegrityError (дубликат role_ack), последующих
    # вызовов scalar/commit быть не должно.
    db.scalar = AsyncMock()
    db.commit = AsyncMock(side_effect=IntegrityError("INSERT", {}, Exception("duplicate")))
    db.rollback = AsyncMock()
    db.add = Mock()

    monkeypatch.setattr(game_engine, "get_current_phase", AsyncMock(return_value=phase))

    with pytest.raises(GameError) as exc_info:
        await game_engine.acknowledge_role(db, session, player)

    assert exc_info.value.status_code == 409
    assert exc_info.value.code == "action_already_submitted"
    db.rollback.assert_awaited_once()
    db.scalar.assert_not_awaited()  # никакие counts не считались
