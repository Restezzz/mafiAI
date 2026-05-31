"""Recovery-сервис для продакшн режима.

Цель: после рестарта backend автоматически продолжать активные игры:
- пересоздавать таймеры (role_reveal/discussion/voting/ночные ходы)
- возобновлять ночную последовательность (mafia -> doctor -> sheriff)

Источник истины: БД (sessions, game_phases, game_events, night_actions, day_votes).
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import select

from core.database import async_session_factory
from core.logging import log_event, log_exception
from core.utils import remaining_seconds
from models.game_phase import GamePhase
from models.session import Session
from services.game_engine import (
    NAME_PICK_DEFAULT_TIMER,
    STORY_VOTE_DEFAULT_TIMER,
    execute_night_sequence,
    get_current_phase,
    resolve_name_pick,
    resolve_story_vote,
    resolve_votes,
    transition_to_day,
    transition_to_night,
    transition_to_voting,
)
from services.runtime_state import runtime_state
from services.state_service import get_last_known_phase, restore_runtime_like_fields
from services.timer_service import timer_service

logger = logging.getLogger(__name__)


async def _recover_one_session(session_id: uuid.UUID) -> None:
    # Важно: recovery может запускать фоновые задачи.
    # Нельзя передавать наружу db-сессию из этого контекста.
    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if not session or session.status != "active":
            log_event(logger, logging.WARNING, "recovery.skipped", "Recovery skipped for inactive session", session_id=str(session_id))
            return
        gp = (session.settings or {}).get("game_pause")
        if isinstance(gp, dict) and gp.get("paused"):
            log_event(logger, logging.WARNING, "recovery.skipped", "Recovery skipped for paused session", session_id=str(session_id))
            return
        rt = runtime_state.get(session_id)
        if rt.phase_transition_running or rt.night_sequence_running or rt.story_engine_running:
            log_event(logger, logging.WARNING, "recovery.skipped", "Recovery skipped for busy runtime", session_id=str(session_id))
            return

        # Story Engine recovery: если сессия в режиме use_story_engine — все
        # ниже идущие legacy ветки (role_reveal/day/night) НЕ применимы,
        # потому что фазы в Story Engine управляются step.payload.phase_action,
        # а timers/sequence — handler'ами role_action/discussion/voting.
        # Просто перезапускаем executor: ``start_story`` идемпотентен,
        # подберёт state.current_step_id и продолжит с того места.
        use_story_engine = bool(
            session.story_id and (session.settings or {}).get("use_story_engine")
        )
        if use_story_engine:
            # КРИТИЧНО: НЕ стартовать Story Engine во время role_reveal,
            # пока `_enter_first_night_or_story` не вызвал start_story
            # официально. Иначе recovery_loop создаст SessionStoryState
            # сразу после game.started (раньше чем юзер нажмёт "Ознакомлен"),
            # и narration сыграется БЕЗ user-gesture'а — браузер заблокирует
            # autoplay → юзер не услышит звук. Признак "официально стартовал":
            # в БД уже есть SessionStoryState.
            from models.session_story_state import SessionStoryState
            existing_state = await db.scalar(
                select(SessionStoryState.session_id).where(
                    SessionStoryState.session_id == session_id
                )
            )
            if existing_state is None:
                log_event(
                    logger, logging.INFO, "recovery.story_engine_skipped",
                    "Story Engine recovery skipped — state not yet initialised "
                    "(role_reveal phase, awaiting acknowledge)",
                    session_id=str(session_id),
                )
                return

            # Локальный импорт чтобы избежать импорта story_runtime в legacy
            # окружении без миграций Story Engine.
            try:
                from services.story_runtime import start_story
            except ImportError:
                log_event(
                    logger, logging.ERROR, "recovery.story_engine_import_failed",
                    "use_story_engine=true но services.story_runtime не импортируется",
                    session_id=str(session_id),
                )
                return
            await start_story(session_id)
            log_event(
                logger, logging.INFO, "recovery.story_engine_resumed",
                "Story Engine executor resumed via recovery_loop",
                session_id=str(session_id),
            )
            return

        phase = await get_current_phase(db, session_id)
        if not phase:
            latest_phase = await get_last_known_phase(db, session_id)
            if not latest_phase:
                log_event(logger, logging.WARNING, "recovery.skipped", "Recovery skipped because phase history is missing", session_id=str(session_id))
                return
            await _recover_missing_phase(session_id, latest_phase)
            log_event(logger, logging.INFO, "recovery.session_restored", "Recovered missing phase", session_id=str(session_id))
            return

        restored = await restore_runtime_like_fields(db, session_id, phase)
        rt.day_sub_phase = restored["sub_phase"]
        rt.night_turn = restored["night_turn"]
        rt.timer_name = restored["timer_name"]
        rt.timer_seconds = restored["timer_seconds"]
        rt.timer_started_at = restored["timer_started_at"]

        remaining = remaining_seconds(rt.timer_seconds, rt.timer_started_at)

        # role_reveal timer
        if phase.phase_type == "role_reveal":
            seconds = remaining if remaining is not None else int((session.settings or {}).get("role_reveal_timer_seconds") or 15)
            if seconds <= 0:
                await transition_to_night(session_id, 1)
                log_event(logger, logging.INFO, "recovery.session_restored", "Recovered role reveal timeout", session_id=str(session_id))
                return
            if not timer_service.has_timer(session_id, "role_reveal"):
                await timer_service.start_timer(session_id, "role_reveal", seconds, lambda: transition_to_night(session_id, 1))
                log_event(logger, logging.INFO, "recovery.session_restored", "Recovered role reveal timer", session_id=str(session_id))
            return

        # story_vote timer (Story Engine pre-game): таймер фазы восстанавливаем
        # из persisted phase_changed; resolve_story_vote идемпотентен.
        if phase.phase_type == "story_vote":
            seconds = remaining if remaining is not None else int((session.settings or {}).get("story_vote_timer_seconds") or STORY_VOTE_DEFAULT_TIMER)
            if seconds <= 0:
                await resolve_story_vote(session_id)
                log_event(logger, logging.INFO, "recovery.session_restored", "Recovered story vote timeout", session_id=str(session_id))
                return
            if not timer_service.has_timer(session_id, "story_vote"):
                await timer_service.start_timer(session_id, "story_vote", seconds, lambda: resolve_story_vote(session_id))
                log_event(logger, logging.INFO, "recovery.session_restored", "Recovered story vote timer", session_id=str(session_id))
            return

        # name_pick timer (Story Engine pre-game): аналогично story_vote.
        if phase.phase_type == "name_pick":
            seconds = remaining if remaining is not None else int((session.settings or {}).get("name_pick_timer_seconds") or NAME_PICK_DEFAULT_TIMER)
            if seconds <= 0:
                await resolve_name_pick(session_id)
                log_event(logger, logging.INFO, "recovery.session_restored", "Recovered name pick timeout", session_id=str(session_id))
                return
            if not timer_service.has_timer(session_id, "name_pick"):
                await timer_service.start_timer(session_id, "name_pick", seconds, lambda: resolve_name_pick(session_id))
                log_event(logger, logging.INFO, "recovery.session_restored", "Recovered name pick timer", session_id=str(session_id))
            return

        # day timers
        if phase.phase_type == "day":
            if rt.day_sub_phase == "discussion":
                seconds = remaining if remaining is not None else int((session.settings or {}).get("discussion_timer_seconds") or 120)
                if seconds <= 0:
                    await transition_to_voting(session_id)
                    log_event(logger, logging.INFO, "recovery.session_restored", "Recovered discussion timeout", session_id=str(session_id))
                    return
                if not timer_service.has_timer(session_id, "discussion"):
                    await timer_service.start_timer(session_id, "discussion", seconds, lambda: transition_to_voting(session_id))
                    log_event(logger, logging.INFO, "recovery.session_restored", "Recovered discussion timer", session_id=str(session_id))
                return
            if rt.day_sub_phase == "voting":
                seconds = remaining if remaining is not None else int((session.settings or {}).get("voting_timer_seconds") or 60)
                if seconds <= 0:
                    await resolve_votes(session_id)
                    log_event(logger, logging.INFO, "recovery.session_restored", "Recovered voting timeout", session_id=str(session_id))
                    return
                if not timer_service.has_timer(session_id, "voting"):
                    await timer_service.start_timer(session_id, "voting", seconds, lambda: resolve_votes(session_id))
                    log_event(logger, logging.INFO, "recovery.session_restored", "Recovered voting timer", session_id=str(session_id))
                return
            # если подфаза потеряна — безопасно считаем discussion
            await transition_to_voting(session_id)
            log_event(logger, logging.INFO, "recovery.session_restored", "Recovered missing day sub-phase", session_id=str(session_id))
            return

        # night: возобновить последовательность
        if phase.phase_type == "night":
            rt.night_sequence_running = True

            async def _run():
                from core.database import async_session_factory as _factory
                try:
                    async with _factory() as db2:
                        s2 = await db2.get(Session, session_id)
                        p2 = await db2.get(GamePhase, phase.id)
                        if s2 and p2:
                            resume_from = None
                            if rt.night_turn:
                                seconds_for_turn = remaining if remaining is not None and remaining > 0 else int((s2.settings or {}).get("night_action_timer_seconds") or 30)
                                resume_from = (rt.night_turn, max(1, seconds_for_turn))
                            await execute_night_sequence(db2, s2, p2, resume_from=resume_from)
                            log_event(logger, logging.INFO, "recovery.session_restored", "Recovered night sequence", session_id=str(session_id))
                finally:
                    rt.night_sequence_running = False

            asyncio.create_task(_run())
            return


async def _recover_missing_phase(session_id: uuid.UUID, latest_phase: GamePhase) -> None:
    rt = runtime_state.get(session_id)
    if rt.phase_transition_running or rt.night_sequence_running:
        return
    async with async_session_factory() as db:
        await restore_runtime_like_fields(db, session_id, latest_phase)

    if latest_phase.phase_type == "role_reveal":
        await transition_to_night(session_id, 1)
        return

    if latest_phase.phase_type == "night":
        await transition_to_day(session_id, latest_phase.phase_number)
        return

    if latest_phase.phase_type == "day":
        await transition_to_night(session_id, latest_phase.phase_number + 1)


async def recover_missing_phase(session_id: uuid.UUID) -> None:
    async with async_session_factory() as db:
        latest_phase = await get_last_known_phase(db, session_id)
        if not latest_phase:
            return
    await _recover_missing_phase(session_id, latest_phase)


async def recovery_loop(poll_seconds: int = 3) -> None:
    """Фоновый процесс: периодически восстанавливает активные сессии."""
    while True:
        try:
            async with async_session_factory() as db:
                active_ids = (
                    await db.scalars(select(Session.id).where(Session.status == "active"))
                ).all()
            for sid in active_ids:
                await _recover_one_session(sid)
        except Exception:
            # не заваливаем сервер — recovery должен быть "best effort"
            log_exception(logger, "recovery.loop_failed", "Recovery loop failed")
        await asyncio.sleep(poll_seconds)
