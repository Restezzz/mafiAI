"""Story Engine executor — runtime-выполнение графа сюжета.

Точка входа: ``start_story(session_id)``. Загружает Story по
``session.story_id``, создаёт ``SessionStoryState`` с
``current_step_id = story.entry_step_id``, запускает диспетчер шагов.

Диспетчер ``_run_step`` по ``step.kind`` вызывает один из handler'ов:
- ``narration``  — играет cues последовательно (через
  ``_play_phase_announcements`` из game_engine для совместимости WS-payload).
- ``role_action`` — таймер + ожидание действия игрока (этап 2.3).
- ``discussion`` — таймер на дискуссию (этап 2.3).
- ``voting``     — голосование (этап 2.3).
- ``night_resolve`` / ``day_resolve`` — вызов legacy-функций
  ``resolve_night`` / ``resolve_votes`` (этап 2.4). Записывают
  winner_team / died_role / vote_tie в ``step_vars`` для условий.
- ``branch``     — без UI, сразу advance.
- ``pause``      — ``asyncio.sleep`` без WS.
- ``end``        — sessions.status='finished', game_finished WS.

После каждого шага вызывается ``_advance``: ищет лучший transition
(сначала по condition match, при равенстве — по priority desc), обновляет
``current_step_id`` и зацикленно вызывает ``_run_step``.

Условия (``StoryTransition.condition``) вычисляются через
``_evaluate_condition`` — поддерживает 8 атомарных типов и рекурсивные
all/any/not. См. design doc §3.4.

Этап 2.2 в текущей реализации: handlers narration/branch/end/pause.
role_action/discussion/voting/night_resolve/day_resolve — stubs с
``NotImplementedError``, реализуются в подэтапах 2.3-2.4.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import async_session_factory
from core.exceptions import GameError
from core.logging import log_event
from core.utils import utc_now
from models.game_phase import GamePhase
from models.session import Session
from models.session_story_state import SessionStoryState
from models.story import (
    Story,
    StoryNarrationCue,
    StorySettings,
    StoryStep,
    StoryTransition,
)
from services.runtime_state import runtime_state
from services.ws_manager import ws_manager


logger = logging.getLogger(__name__)


# Максимальная глубина цепочки переходов в одном tick (защита от бесконечного
# цикла в графе с циклом через branch без задержек). После N переходов
# подряд executor бросает RuntimeError — это явная ошибка конфигурации сюжета.
_MAX_ADVANCE_DEPTH = 100


# ============================================================================
# Public API
# ============================================================================


async def start_story(session_id: uuid.UUID) -> None:
    """Запустить Story Engine на сессии.

    Вызывается вместо ``transition_to_night(session_id, 1)`` если
    ``session.story_id`` задан и ``session.settings.use_story_engine`` true.

    Идемпотентно: если ``SessionStoryState`` уже существует и не пуст —
    возобновляет с ``current_step_id`` (recovery после крэша воркера).
    """
    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            log_event(
                logger, logging.WARNING, "story_engine.start_failed",
                "Session not found",
                session_id=str(session_id),
            )
            return
        if session.story_id is None:
            log_event(
                logger, logging.WARNING, "story_engine.start_failed",
                "Session has no story_id — cannot run Story Engine",
                session_id=str(session_id),
            )
            return

        story = await _load_story_full(db, session.story_id)
        if story is None:
            log_event(
                logger, logging.ERROR, "story_engine.start_failed",
                "Story not found",
                session_id=str(session_id),
                story_id=str(session.story_id),
            )
            return
        if story.entry_step_id is None:
            log_event(
                logger, logging.ERROR, "story_engine.start_failed",
                "Story has no entry_step_id",
                session_id=str(session_id),
                story_id=str(story.id),
            )
            return

        # Загружаем или создаём state.
        state = await db.scalar(
            select(SessionStoryState).where(SessionStoryState.session_id == session_id)
        )
        resumed = False
        if state is None:
            state = SessionStoryState(
                session_id=session_id,
                current_step_id=story.entry_step_id,
                step_started_at=utc_now(),
                step_vars={},
            )
            db.add(state)
            await db.commit()
        elif state.current_step_id is None:
            # Был state, но шаг занулился (сюжет удалили? aborted?). Стартуем
            # с entry заново.
            state.current_step_id = story.entry_step_id
            state.step_started_at = utc_now()
            state.step_vars = {}
            await db.commit()
        else:
            resumed = True

        log_event(
            logger, logging.INFO, "story_engine.started",
            "Story Engine started" if not resumed else "Story Engine resumed",
            session_id=str(session_id),
            story_id=str(story.id),
            current_step=str(state.current_step_id),
            resumed=resumed,
        )

    # Запускаем executor вне транзакции, чтобы не держать connection
    # на всю длину сюжета. Каждый handler открывает свою сессию.
    asyncio.create_task(_run_loop(session_id))


# ============================================================================
# Internal: main loop & dispatch
# ============================================================================


async def _run_loop(session_id: uuid.UUID) -> None:
    """Главный цикл executor'а: пока state.current_step_id не None — run + advance.

    Запускается как ``asyncio.create_task`` чтобы HTTP-handler'ы (start_game,
    acknowledge_role) завершались моментально.
    """
    advance_depth = 0
    while True:
        rt = runtime_state.get(session_id)
        if rt.game_paused:
            # Пауза остановит цикл; resume_game перезапустит _run_loop
            # через recovery_loop или через сам обработчик resume.
            log_event(
                logger, logging.INFO, "story_engine.paused",
                "Story Engine loop paused",
                session_id=str(session_id),
            )
            return

        async with async_session_factory() as db:
            state = await _load_state(db, session_id)
            if state is None or state.current_step_id is None:
                log_event(
                    logger, logging.INFO, "story_engine.finished",
                    "Story Engine loop finished (no current step)",
                    session_id=str(session_id),
                )
                return

            step = await db.scalar(
                select(StoryStep)
                .where(StoryStep.id == state.current_step_id)
                .options(selectinload(StoryStep.cues).selectinload(StoryNarrationCue.trigger))
            )
            if step is None:
                log_event(
                    logger, logging.ERROR, "story_engine.step_missing",
                    "Current step disappeared from DB",
                    session_id=str(session_id),
                    step_id=str(state.current_step_id),
                )
                return

        # Выполнить шаг (открывает свою db-сессию по необходимости).
        try:
            await _run_step(session_id, step)
        except NotImplementedError as exc:
            log_event(
                logger, logging.ERROR, "story_engine.kind_not_implemented",
                f"Step kind not implemented: {exc}",
                session_id=str(session_id),
                step_kind=step.kind,
                step_slug=step.slug,
            )
            return
        except Exception:
            logger.exception(
                "story_engine.step_failed: session=%s step=%s",
                session_id,
                step.slug,
            )
            return

        # Проверяем не пауза ли это после step. Pause-handler уже мог поставить
        # game_paused = True; повторный check before advance.
        rt = runtime_state.get(session_id)
        if rt.game_paused:
            return

        # End-step не имеет outgoing — выходим.
        if step.kind == "end":
            return

        # Перейти к следующему шагу.
        async with async_session_factory() as db:
            state = await _load_state(db, session_id)
            if state is None:
                return
            advanced = await _advance(db, session_id, state, step)
        if not advanced:
            log_event(
                logger, logging.WARNING, "story_engine.no_advance",
                "No transition matched — story terminated unexpectedly",
                session_id=str(session_id),
                step_slug=step.slug,
            )
            return

        advance_depth += 1
        if advance_depth >= _MAX_ADVANCE_DEPTH:
            log_event(
                logger, logging.ERROR, "story_engine.cycle_protection",
                "Hit _MAX_ADVANCE_DEPTH — likely infinite loop in story graph",
                session_id=str(session_id),
                depth=advance_depth,
            )
            return


async def _run_step(session_id: uuid.UUID, step: StoryStep) -> None:
    """Диспетчер по ``step.kind``."""
    log_event(
        logger, logging.DEBUG, "story_engine.run_step",
        "Running step",
        session_id=str(session_id),
        step_slug=step.slug,
        step_kind=step.kind,
    )
    handlers: dict[str, Any] = {
        "narration": _handle_narration,
        "branch": _handle_branch,
        "end": _handle_end,
        "pause": _handle_pause,
        "role_action": _handle_role_action,
        "discussion": _handle_discussion,
        "voting": _handle_voting,
        "night_resolve": _handle_night_resolve,
        "day_resolve": _handle_day_resolve,
    }
    handler = handlers.get(step.kind)
    if handler is None:
        raise GameError(500, "unknown_step_kind", f"Unknown step.kind: {step.kind}")
    await handler(session_id, step)


# ============================================================================
# Internal: advance & condition evaluation
# ============================================================================


async def _advance(
    db: AsyncSession,
    session_id: uuid.UUID,
    state: SessionStoryState,
    current_step: StoryStep,
) -> bool:
    """Найти лучший transition из current_step и обновить state.

    Алгоритм:
    1. Собрать все исходящие transitions.
    2. Для каждого вычислить condition (None => True).
    3. Из удовлетворяющих — выбрать с наивысшим priority. Tie-break — UUID asc
       (детерминированный, а не random).
    4. Обновить state.current_step_id, step_started_at.

    Возвращает True если нашли next, False если ни один transition не подошёл.
    """
    transitions = (
        await db.scalars(
            select(StoryTransition)
            .where(StoryTransition.from_step_id == current_step.id)
            .order_by(StoryTransition.priority.desc(), StoryTransition.id)
        )
    ).all()

    matching: list[StoryTransition] = []
    for t in transitions:
        if _evaluate_condition(t.condition, state.step_vars):
            matching.append(t)

    if not matching:
        return False

    # Уже отсортированы по priority desc — берём первый.
    chosen = matching[0]
    state.current_step_id = chosen.to_step_id
    state.step_started_at = utc_now()
    await db.commit()

    log_event(
        logger, logging.INFO, "story_engine.advanced",
        "Advanced to next step",
        session_id=str(session_id),
        from_step=current_step.slug,
        to_step_id=str(chosen.to_step_id),
        priority=chosen.priority,
        had_condition=chosen.condition is not None,
    )
    return True


def _evaluate_condition(
    condition: dict[str, Any] | None,
    step_vars: dict[str, Any],
) -> bool:
    """Вычислить condition против ``step_vars``.

    None => True (безусловный fallback).
    Инвалидное condition (отсутствует тип / неизвестный тип) => False
    (graceful degradation, ошибка пишется в лог).
    """
    if condition is None:
        return True

    cond_type = condition.get("type")
    if cond_type is None:
        log_event(
            logger, logging.WARNING, "story_engine.condition_missing_type",
            "Condition without type field",
            condition=condition,
        )
        return False

    # Композитные.
    if cond_type == "all":
        children = condition.get("conditions") or []
        return all(_evaluate_condition(c, step_vars) for c in children)
    if cond_type == "any":
        children = condition.get("conditions") or []
        return any(_evaluate_condition(c, step_vars) for c in children)
    if cond_type == "not":
        inner = condition.get("condition")
        return not _evaluate_condition(inner, step_vars)

    # Атомарные предикаты.
    if cond_type == "winner":
        team = condition.get("team")
        # null team — match если winner определён (любая команда), иначе False.
        winner_team = step_vars.get("winner_team")
        if team is None:
            return winner_team is not None
        return winner_team == team

    if cond_type == "phase_number":
        op = condition.get("op")
        value = condition.get("value")
        actual = step_vars.get("phase_number", 0)
        return _compare(actual, op, value)

    if cond_type == "vote_tie":
        return bool(step_vars.get("vote_tie", False))

    if cond_type == "died_role":
        target_slug = condition.get("role_slug")
        return step_vars.get("died_role") == target_slug

    if cond_type == "death_cause":
        return step_vars.get("death_cause") == condition.get("value")

    if cond_type == "role_alive":
        # Требует синхронной выгрузки alive players по ролям. Этап 2.4
        # запишет в step_vars `alive_roles: set[role_slug]` после night_resolve.
        target_slug = condition.get("role_slug")
        alive_roles = step_vars.get("alive_roles") or []
        return target_slug in alive_roles

    if cond_type == "role_dead":
        target_slug = condition.get("role_slug")
        alive_roles = step_vars.get("alive_roles") or []
        return target_slug not in alive_roles

    if cond_type == "step_var":
        key = condition.get("key")
        op = condition.get("op")
        value = condition.get("value")
        actual = step_vars.get(key)
        return _compare(actual, op, value)

    log_event(
        logger, logging.WARNING, "story_engine.unknown_condition_type",
        f"Unknown condition type: {cond_type}",
        condition=condition,
    )
    return False


def _compare(actual: Any, op: str | None, expected: Any) -> bool:
    """Безопасное сравнение для условий phase_number / step_var.

    Если типы несравнимы — возвращает False (не падает).
    """
    if op is None:
        return False
    try:
        if op == "==":
            return actual == expected
        if op == "!=":
            return actual != expected
        if op == ">=":
            return actual >= expected
        if op == "<=":
            return actual <= expected
        if op == ">":
            return actual > expected
        if op == "<":
            return actual < expected
    except TypeError:
        # Несравнимые типы (например None vs int) — False.
        return False
    return False


# ============================================================================
# Handlers
# ============================================================================


async def _handle_narration(session_id: uuid.UUID, step: StoryStep) -> None:
    """Проиграть все cues шага через legacy ``_play_phase_announcements``.

    Переиспользуем функцию из game_engine — она уже шлёт правильный
    WS payload (``phase_changed`` с ``announcement``), стампит ``started_at``,
    учитывает паузу через ``_wait_or_pause``, persist'ит в GameEvent.

    Cues конвертируются в формат ожидаемый ``resolve_steps``:
      [{"step_index": 1, "steps_total": N, "trigger": "<slug>",
        "text": "<override or null>", "duration_ms": <override or null>}, ...]
    """
    # Локальный импорт чтобы избежать циклической зависимости
    # game_engine ↔ story_runtime (game_engine может быть импортирован
    # из других мест раньше).
    from services.game_engine import _play_phase_announcements, get_current_phase

    cues = sorted(step.cues, key=lambda c: c.sort_order)
    if not cues:
        return

    # Текущая фаза для phase_payload (используем активную GamePhase из БД,
    # т.к. она актуализируется в night_resolve / day_resolve через
    # transition_to_night / transition_to_day).
    async with async_session_factory() as db:
        phase = await get_current_phase(db, session_id)
        if phase is None:
            log_event(
                logger, logging.WARNING, "story_engine.no_phase",
                "Narration step has no active GamePhase — using role_reveal fallback",
                session_id=str(session_id),
                step_slug=step.slug,
            )
            return
        phase_payload = {
            "phase": {"type": phase.phase_type, "number": phase.phase_number},
            "sub_phase": None,
            "timer_seconds": None,
            "timer_started_at": None,
        }
        narration_steps = _build_narration_steps(step, cues)
        await _play_phase_announcements(
            session_id,
            phase_payload,
            narration_steps,
            db=db,
            phase_id=phase.id,
            persist=True,
        )


def _build_narration_steps(
    step: StoryStep, cues: list[StoryNarrationCue]
) -> list[dict[str, Any]]:
    """Преобразует ORM-cues в формат ожидаемый ``resolve_steps``.

    Каждый cue → dict с ключами trigger / text / duration_ms / step_index /
    steps_total. ``trigger_slug`` берётся из relationship (eager loaded),
    fallback на None если триггер удалили.
    """
    total = len(cues)
    items: list[dict[str, Any]] = []
    for idx, cue in enumerate(cues, start=1):
        trigger_slug = cue.trigger.slug if cue.trigger else None
        item: dict[str, Any] = {
            "step_index": idx,
            "steps_total": total,
            "trigger": trigger_slug,
            "text": cue.override_text,
            "duration_ms": cue.override_duration_ms,
        }
        items.append(item)
    return items


async def _handle_branch(session_id: uuid.UUID, step: StoryStep) -> None:
    """Branch не имеет UI — просто фиксируется в логе. Advance делает _run_loop."""
    log_event(
        logger, logging.DEBUG, "story_engine.branch",
        "Branch step encountered (no UI)",
        session_id=str(session_id),
        step_slug=step.slug,
    )


async def _handle_pause(session_id: uuid.UUID, step: StoryStep) -> None:
    """Тихая пауза. Длительность из step.payload.duration_ms (default 1000).

    Используется для inter-cue gap'ов между крупными секциями (если admin
    хочет 2-3 секунды тишины между «Доктор закрыл глаза» и «Утро»).
    """
    duration_ms = int(step.payload.get("duration_ms", 1000))
    if duration_ms <= 0:
        return
    # Локальный импорт чтобы не тянуть game_engine в test env без БД.
    from services.game_engine import _wait_or_pause

    await _wait_or_pause(session_id, duration_ms / 1000)


async def _handle_end(session_id: uuid.UUID, step: StoryStep) -> None:
    """Финал. Закрываем сессию, шлём WS, обнуляем state."""
    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        state = await db.scalar(
            select(SessionStoryState).where(SessionStoryState.session_id == session_id)
        )
        winner = None
        if state and state.step_vars:
            winner = state.step_vars.get("winner_team")

        session.status = "finished"
        session.ended_at = utc_now()
        if state:
            state.current_step_id = None  # signal: больше нечего делать
        await db.commit()

        log_event(
            logger, logging.INFO, "story_engine.end",
            "Story Engine reached end step",
            session_id=str(session_id),
            winner_team=winner,
        )
        await ws_manager.send_to_session(
            session_id,
            {
                "type": "game_finished",
                "payload": {
                    "winner": winner,
                    "ended_at": session.ended_at.isoformat(),
                    "phase": {"type": "finished", "number": 0},
                },
            },
        )


# ============================================================================
# Handlers — stubs (этапы 2.3-2.4)
# ============================================================================


async def _handle_role_action(session_id: uuid.UUID, step: StoryStep) -> None:
    """Stub: действие игрока с ролью. Этап 2.3."""
    raise NotImplementedError("role_action handler — этап 2.3")


async def _handle_discussion(session_id: uuid.UUID, step: StoryStep) -> None:
    """Stub: дневная дискуссия. Этап 2.3."""
    raise NotImplementedError("discussion handler — этап 2.3")


async def _handle_voting(session_id: uuid.UUID, step: StoryStep) -> None:
    """Stub: голосование. Этап 2.3."""
    raise NotImplementedError("voting handler — этап 2.3")


async def _handle_night_resolve(session_id: uuid.UUID, step: StoryStep) -> None:
    """Stub: подсчёт жертв ночи. Этап 2.4."""
    raise NotImplementedError("night_resolve handler — этап 2.4")


async def _handle_day_resolve(session_id: uuid.UUID, step: StoryStep) -> None:
    """Stub: резолв голосования. Этап 2.4."""
    raise NotImplementedError("day_resolve handler — этап 2.4")


# ============================================================================
# Helpers
# ============================================================================


async def _load_story_full(db: AsyncSession, story_id: uuid.UUID) -> Story | None:
    """Eager-load Story со всеми зависимостями для executor'а."""
    return await db.scalar(
        select(Story)
        .where(Story.id == story_id)
        .options(
            selectinload(Story.settings),
        )
    )


async def _load_state(
    db: AsyncSession, session_id: uuid.UUID
) -> SessionStoryState | None:
    return await db.scalar(
        select(SessionStoryState).where(SessionStoryState.session_id == session_id)
    )
