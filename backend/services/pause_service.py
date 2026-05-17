"""Пауза / снятие паузы активной игры (хост). Снимок таймера в sessions.settings.game_pause."""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from core.database import async_session_factory
from core.exceptions import GameError
from core.logging import log_event
from core.utils import remaining_seconds, safe_uuid, utc_now
from models.game_phase import GamePhase
from models.session import Session
from services.game_engine import execute_night_sequence, get_current_phase, resolve_votes, transition_to_voting
from services.runtime_state import runtime_state
from services.timer_service import timer_service
from services.ws_manager import ws_manager

PAUSE_KEY = "game_pause"
logger = logging.getLogger(__name__)


async def pause_game(db: AsyncSession, session: Session) -> dict:
    if session.status != "active":
        raise GameError(409, "wrong_phase", "Пауза доступна только во время активной игры")
    cur = session.settings or {}
    if isinstance(cur.get(PAUSE_KEY), dict) and cur[PAUSE_KEY].get("paused"):
        raise GameError(409, "already_paused", "Игра уже на паузе")

    phase = await get_current_phase(db, session.id)
    if not phase:
        raise GameError(409, "wrong_phase", "Нет активной фазы")

    rt = runtime_state.get(session.id)
    remaining = remaining_seconds(rt.timer_seconds, rt.timer_started_at)

    snap: dict = {
        "phase_type": phase.phase_type,
        "phase_id": str(phase.id),
        "phase_number": phase.phase_number,
        "timer_name": rt.timer_name,
        "day_sub_phase": rt.day_sub_phase,
        "remaining_seconds": remaining,
        "night_turn": rt.night_turn,
        "mafia_choice_target": str(rt.mafia_choice_target) if rt.mafia_choice_target else None,
        "mafia_choice_by": str(rt.mafia_choice_by) if rt.mafia_choice_by else None,
        "maniac_choice_target": str(rt.maniac_choice_target) if rt.maniac_choice_target else None,
        "lover_last_target": str(rt.lover_last_target) if rt.lover_last_target else None,
        "day_blocked_player": str(rt.day_blocked_player) if rt.day_blocked_player else None,
        "blocked_tonight": [str(x) for x in rt.blocked_tonight],
    }

    # Cancel timers and set game_paused BEFORE db.commit() to prevent
    # a race where a timer callback fires during the commit and triggers
    # a phase transition before we've saved the pause snapshot.
    rt.game_paused = True
    # События для прерываемого ожидания в _wait_or_pause (#9):
    # pause_event.set() будит любой текущий wait_for(...) в фазе;
    # resume_event.clear() — следующая итерация цикла _wait_or_pause увидит paused
    # и заблокируется на resume_event.wait() пока не сделают resume_game.
    rt.pause_event.set()
    rt.resume_event.clear()
    await timer_service.cancel_all(session.id)
    rt.night_action_event.set()

    settings = {**cur, PAUSE_KEY: {"paused": True, "snapshot": snap}}
    session.settings = settings
    await db.commit()
    log_event(logger, logging.INFO, "game.paused", "Pause snapshot persisted", session_id=str(session.id))

    await ws_manager.send_to_session(
        session.id,
        {"type": "game_paused", "payload": {"snapshot": snap, "announcement": {"trigger": "game_paused"}}},
    )
    return {"paused": True, "snapshot": snap}


async def resume_game(session_id: uuid.UUID) -> None:
    snap: dict
    phase_id_uuid: uuid.UUID

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            raise GameError(404, "session_not_found", "Сессия не найдена")
        if session.status != "active":
            raise GameError(409, "wrong_phase", "Сессия не в игре")
        cur = session.settings or {}
        gp = cur.get(PAUSE_KEY) if isinstance(cur.get(PAUSE_KEY), dict) else {}
        if not gp.get("paused"):
            raise GameError(409, "not_paused", "Игра не на паузе")
        snap = dict(gp.get("snapshot") or {})
        if not snap.get("phase_id"):
            raise GameError(409, "phase_mismatch", "Битый снимок паузы")
        phase_id_uuid = uuid.UUID(str(snap["phase_id"]))
        phase_row = await db.get(GamePhase, phase_id_uuid)
        if not phase_row or phase_row.session_id != session_id or phase_row.ended_at is not None:
            raise GameError(409, "phase_mismatch", "Фаза изменилась, нельзя снять паузу автоматически")

        settings = {k: v for k, v in cur.items() if k != PAUSE_KEY}
        session.settings = settings
        await db.commit()

    rt = runtime_state.get(session_id)
    rt.game_paused = False
    # Симметрично pause_game (#9): сбрасываем pause_event и поднимаем resume_event,
    # чтобы _wait_or_pause продолжил счёт оставшегося времени фазы.
    rt.pause_event.clear()
    rt.resume_event.set()
    rt.night_sequence_abort = False

    ptype = snap.get("phase_type")
    rem = int(snap["remaining_seconds"]) if snap.get("remaining_seconds") is not None else None
    if rem is None or rem < 1:
        rem = 1

    rt.mafia_choice_target = safe_uuid(snap.get("mafia_choice_target"))
    rt.mafia_choice_by = safe_uuid(snap.get("mafia_choice_by"))
    rt.maniac_choice_target = safe_uuid(snap.get("maniac_choice_target"))
    rt.lover_last_target = safe_uuid(snap.get("lover_last_target"))
    rt.day_blocked_player = safe_uuid(snap.get("day_blocked_player"))

    restored_blocked: set[uuid.UUID] = set()
    for item in snap.get("blocked_tonight", []) or []:
        u = safe_uuid(item)
        if u is not None:
            restored_blocked.add(u)
    rt.blocked_tonight = restored_blocked

    if ptype == "role_reveal":
        from services.game_engine import transition_to_night

        async def _on_timeout():
            await transition_to_night(session_id, 1)

        rt.day_sub_phase = None
        rt.night_turn = None
        rt.timer_name = "role_reveal"
        rt.timer_seconds = rem
        rt.timer_started_at = utc_now()
        await timer_service.start_timer(session_id, "role_reveal", rem, _on_timeout)
        await ws_manager.send_to_session(
            session_id,
            {
                "type": "game_resumed",
                "payload": {
                    "phase": {"type": "role_reveal", "number": int(snap.get("phase_number") or 0)},
                    "timer_seconds": rem,
                    "timer_started_at": rt.timer_started_at.isoformat(),
                    "announcement": {"trigger": "game_resumed"},
                },
            },
        )
        log_event(logger, logging.INFO, "game.resumed", "Role reveal resumed from pause", session_id=str(session_id))
        return

    if ptype == "day":
        rt.day_sub_phase = snap.get("day_sub_phase") or "discussion"
        rt.timer_started_at = utc_now()
        rt.timer_seconds = rem
        if rt.day_sub_phase == "discussion":
            rt.timer_name = "discussion"

            async def _to_voting():
                await transition_to_voting(session_id)

            await timer_service.start_timer(session_id, "discussion", rem, _to_voting)
        else:
            rt.timer_name = "voting"

            async def _res():
                await resolve_votes(session_id)

            await timer_service.start_timer(session_id, "voting", rem, _res)

        await ws_manager.send_to_session(
            session_id,
            {
                "type": "game_resumed",
                "payload": {
                    "phase": {"type": "day", "number": int(snap.get("phase_number") or 0)},
                    "sub_phase": rt.day_sub_phase,
                    "timer_seconds": rem,
                    "timer_started_at": rt.timer_started_at.isoformat(),
                    "announcement": {"trigger": "game_resumed"},
                },
            },
        )
        log_event(logger, logging.INFO, "game.resumed", "Day phase resumed from pause", session_id=str(session_id))
        return

    if ptype == "night":
        nt = str(snap.get("night_turn") or "mafia")
        rt.timer_started_at = utc_now()
        rt.timer_seconds = rem
        await ws_manager.send_to_session(
            session_id,
            {
                "type": "game_resumed",
                "payload": {
                    "phase": {"type": "night", "number": int(snap.get("phase_number") or 0)},
                    "night_turn": nt,
                    "timer_seconds": rem,
                    "timer_started_at": rt.timer_started_at.isoformat(),
                    "announcement": {"trigger": "game_resumed"},
                },
            },
        )
        async with async_session_factory() as db2:
            s2 = await db2.get(Session, session_id)
            ph2 = await db2.get(GamePhase, phase_id_uuid)
            if not s2 or not ph2:
                return
            log_event(logger, logging.INFO, "game.resumed", "Night phase resumed from pause", session_id=str(session_id))
            await execute_night_sequence(db2, s2, ph2, resume_from=(nt, rem))
        return

    raise GameError(500, "internal_error", "Неизвестный тип фазы в снимке паузы")
