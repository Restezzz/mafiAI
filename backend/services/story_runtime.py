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

Состояние этапа 2.4: все handlers реализованы. role_action делает
базовый timer + action_required + wait на night_action_event. discussion/
voting — timer + WS phase_changed. night_resolve / day_resolve вызывают
legacy resolve_night / resolve_votes из game_engine и записывают в
step_vars: winner_team, phase_number, vote_tie, died_role, death_cause,
alive_roles — эти ключи используются в conditions transitions.

Phase transitions: step.payload.phase_action ∈ {enter_night, enter_day,
enter_finished} выполняется в ``_apply_phase_action`` ПЕРЕД handler'ом.
Создаёт новую GamePhase, закрывает старую, шлёт phase_changed.
Ограничения MVP (исправяются в этапе 7 при удалении legacy):
- role_action поддерживает только одного actor'а (для мафии — первый
  по join_order, остальные не видят action_required).
- Нет lover_block, doctor heal restriction, don't-attack-team.
- voting — один раунд, без tie-break переголосовки.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import async_session_factory
from core.exceptions import GameError
from core.logging import log_event
from core.utils import utc_now
from models.day_vote import DayVote
from models.game_event import GameEvent
from models.game_phase import GamePhase
from models.night_action import NightAction
from models.player import Player
from models.role import Role
from models.session import Session
from models.session_story_state import SessionStoryState
from models.narrator import (
    NarratorAudioFile,
    NarratorNameAsset,
    NarratorTrigger,
    NarratorVariant,
)
from models.story import (
    Story,
    StoryName,
    StoryNameVariant,
    StoryNameVariantAsset,
    StoryNarrationCue,
    StorySettings,
    StoryStep,
    StoryTransition,
)
from services.runtime_state import runtime_state
from services.timer_service import timer_service
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

    # Защита от двойного запуска: если executor уже работает (например
    # recovery_loop вызвал start_story повторно), не запускаем второй task.
    # Без этого получим race-condition: два _run_loop конкурируют за
    # current_step_id, шлют дубликаты WS phase_changed, перетирают timers.
    rt = runtime_state.get(session_id)
    if rt.story_engine_running:
        log_event(
            logger, logging.INFO, "story_engine.start_skipped",
            "Story Engine executor already running — skipping duplicate start",
            session_id=str(session_id),
        )
        return

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

    Устанавливает rt.story_engine_running=True в начале, False в finally —
    это нужно для защиты от двойного запуска через recovery_loop / повторный
    start_story (см. ``start_story`` выше).
    """
    rt = runtime_state.get(session_id)
    rt.story_engine_running = True
    try:
        await _run_loop_inner(session_id)
    finally:
        rt.story_engine_running = False
        log_event(
            logger, logging.INFO, "story_engine.loop_exited",
            "Story Engine _run_loop exited",
            session_id=str(session_id),
        )


async def _run_loop_inner(session_id: uuid.UUID) -> None:
    """Содержимое _run_loop без флаг-обвязки (вынесено для finally-cleanup)."""
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
    # Pre-step: если step.payload.phase_action задан — создаём новую GamePhase
    # и шлём phase_changed ДО того как handler начнёт использовать эту фазу.
    await _apply_phase_action(session_id, step)
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
        "text": "<override or null>", "duration_ms": <override or null>,
        "karaoke": <bool из story.settings.karaoke_enabled>}, ...]

    ``karaoke`` флаг пробрасывается во фронт через announcement — фронт
    выбирает режим рендеринга (per-word подсветка vs per-char typewriter).
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

        # Подтягиваем эффективные настройки сюжета: story.settings базовое +
        # session.settings.{timer_multiplier, inter_cue_pause_seconds} как
        # overrides (этап 3). Если ничего не задано — дефолты
        # (karaoke=True, multiplier=1.0, pause=0.0).
        session = await db.get(Session, session_id)
        eff = await _load_effective_settings(db, session)

        # Подгружаем варианты с аудио для каждого триггера cue (story-scoped
        # триггеры из админки не лежат в audio_manifest.json, поэтому Story
        # Engine резолвит их напрямую из БД и pre-fill'ит шаги).
        trigger_ids = [c.trigger_id for c in cues if c.trigger_id is not None]
        variants_by_trigger: dict[uuid.UUID, list[NarratorVariant]] = {}
        if trigger_ids:
            triggers = (
                await db.scalars(
                    select(NarratorTrigger)
                    .where(NarratorTrigger.id.in_(trigger_ids))
                    .options(
                        selectinload(NarratorTrigger.variants).selectinload(
                            NarratorVariant.audio_file
                        )
                    )
                )
            ).all()
            for t in triggers:
                variants_by_trigger[t.id] = list(t.variants)

        # Фича 1: инъекция варианта произношения имени. Если хоть у одной cue
        # задан name_variant_key — резолвим аудио имени жертвы (из step_vars,
        # выставленного предыдущим night/day_resolve) под нужный вариант.
        name_audio_by_variant: dict[str, NarratorAudioFile] = {}
        target_player_name: str | None = None
        if any(c.name_variant_key for c in cues) and session and session.story_id:
            target_player_name, name_audio_by_variant = await _resolve_variant_name_audio(
                db,
                session_id=session_id,
                story_id=session.story_id,
                variant_keys={c.name_variant_key for c in cues if c.name_variant_key},
            )

        phase_payload = {
            "phase": {"type": phase.phase_type, "number": phase.phase_number},
            "sub_phase": None,
            "timer_seconds": None,
            "timer_started_at": None,
        }
        narration_steps = _build_narration_steps(
            step, cues,
            karaoke=eff["karaoke"],
            multiplier=eff["multiplier"],
            inter_cue_pause_ms=int(eff["inter_cue_pause_seconds"] * 1000),
            variants_by_trigger=variants_by_trigger,
            session_id=session_id,
            name_audio_by_variant=name_audio_by_variant,
            target_player_name=target_player_name,
        )
        await _play_phase_announcements(
            session_id,
            phase_payload,
            narration_steps,
            db=db,
            phase_id=phase.id,
            persist=True,
        )


async def _resolve_variant_name_audio(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    story_id: uuid.UUID,
    variant_keys: set[str],
) -> tuple[str | None, dict[str, NarratorAudioFile]]:
    """Резолвит аудио имени жертвы под каждый вариант произношения.

    Возвращает ``(target_player_name, {variant_key: NarratorAudioFile})``.

    Целевое имя берётся из ``step_vars.died_player_name`` (выставляется
    night/day_resolve). Для каждого ``variant_key`` ищется ассет варианта
    с привязанным аудио для соответствующего имени каталога. Если для пары
    (variant, name) аудио не задано — ключ просто отсутствует в результате
    (рантайм фолбэкнется на дефолтное аудио имени).
    """
    state = await _load_state(db, session_id)
    target_name: str | None = None
    if state and state.step_vars:
        raw = state.step_vars.get("died_player_name")
        if isinstance(raw, str) and raw.strip():
            target_name = raw.strip()
    if not target_name:
        return None, {}

    # Источник имени — собственный набор сюжета (story_names) по display_name
    # (case-insensitive), c дефолтным аудио имени. Фолбэк: если у сюжета нет
    # своих имён — глобальный каталог narrator_name_assets (старый путь).
    story_name = await db.scalar(
        select(StoryName)
        .where(
            StoryName.story_id == story_id,
            func.lower(StoryName.display_name) == target_name.lower(),
        )
        .options(selectinload(StoryName.base_audio_file))
    )
    story_name_id: uuid.UUID | None = None
    default_audio: NarratorAudioFile | None = None
    if story_name is not None:
        story_name_id = story_name.id
        default_audio = story_name.base_audio_file
    else:
        has_own_names = await db.scalar(
            select(func.count())
            .select_from(StoryName)
            .where(StoryName.story_id == story_id)
        )
        if has_own_names:
            # У сюжета есть свой набор имён, но целевого имени в нём нет —
            # озвучить нечем.
            return target_name, {}
        name_asset = await db.scalar(
            select(NarratorNameAsset)
            .where(func.lower(NarratorNameAsset.display_name) == target_name.lower())
            .options(selectinload(NarratorNameAsset.audio_file))
        )
        if name_asset is None:
            return target_name, {}
        story_name_id = name_asset.id
        default_audio = name_asset.audio_file

    variants = (
        await db.scalars(
            select(StoryNameVariant)
            .where(
                StoryNameVariant.story_id == story_id,
                StoryNameVariant.key.in_(variant_keys),
            )
            .options(
                selectinload(StoryNameVariant.assets).selectinload(
                    StoryNameVariantAsset.audio_file
                )
            )
        )
    ).all()

    by_key: dict[str, NarratorAudioFile] = {}
    for variant in variants:
        for asset in variant.assets:
            if asset.story_name_id == story_name_id and asset.audio_file is not None:
                by_key[variant.key] = asset.audio_file
                break
    # Фолбэк на дефолтное аудио имени для ключей без своего варианта.
    if default_audio is not None:
        for key in variant_keys:
            by_key.setdefault(key, default_audio)
    return target_name, by_key


def _build_narration_steps(
    step: StoryStep,
    cues: list[StoryNarrationCue],
    *,
    karaoke: bool = False,
    multiplier: float = 1.0,
    inter_cue_pause_ms: int = 0,
    variants_by_trigger: dict[uuid.UUID, list[NarratorVariant]] | None = None,
    session_id: uuid.UUID | None = None,
    name_audio_by_variant: dict[str, NarratorAudioFile] | None = None,
    target_player_name: str | None = None,
) -> list[dict[str, Any]]:
    """Преобразует ORM-cues в формат ожидаемый ``resolve_steps``.

    Каждый cue → dict с ключами trigger / text / duration_ms / step_index /
    steps_total / karaoke / post_pause_ms. ``trigger_slug`` берётся из
    relationship (eager loaded), fallback на None если триггер удалили.

    Если для триггера cue есть варианты в ``variants_by_trigger`` —
    выбираем один (seeded по session_id+cue.id для воспроизводимости) и
    pre-fill'им ``audio_url`` / ``audio_file_name`` / ``duration_ms`` / ``text``
    в шаге. ``resolve_steps`` в narration_audio.py видит уже резолвнутые
    данные (триггер не в манифесте) и возвращает шаг как есть.

    ``multiplier`` (этап 3) умножает duration_ms (override или из аудио).
    ``inter_cue_pause_ms`` добавляется в ``post_pause_ms`` каждого cue кроме
    последнего.
    """
    total = len(cues)
    items: list[dict[str, Any]] = []
    for idx, cue in enumerate(cues, start=1):
        trigger_slug = cue.trigger.slug if cue.trigger else None
        scaled_duration = cue.override_duration_ms
        override_text = cue.override_text

        # Резолвим вариант из БД (если есть). Seed = (session_id, cue.id)
        # чтобы повтор после крэша/реконнекта выбрал тот же вариант.
        variant_audio_url: str | None = None
        variant_audio_filename: str | None = None
        variant_text: str | None = None
        variant_duration_ms: int | None = None
        if (
            cue.trigger_id is not None
            and variants_by_trigger
            and cue.trigger_id in variants_by_trigger
        ):
            variants = variants_by_trigger[cue.trigger_id]
            if variants:
                seed = hash((str(session_id), str(cue.id))) if session_id else 0
                chosen = variants[seed % len(variants)]
                variant_text = chosen.text
                variant_duration_ms = chosen.duration_ms
                if chosen.audio_file is not None:
                    variant_audio_url = f"/audio/{chosen.audio_file.storage_path}"
                    variant_audio_filename = chosen.audio_file.filename
                    # Если у варианта нет своего duration_ms, берём из аудио-файла.
                    if variant_duration_ms is None:
                        variant_duration_ms = chosen.audio_file.duration_ms

        # duration_ms: override > variant > None (фронт fallback'нется на mp3)
        effective_duration = scaled_duration
        if effective_duration is None:
            effective_duration = variant_duration_ms
        if effective_duration is not None and multiplier != 1.0:
            effective_duration = int(effective_duration * multiplier)

        # text: override > variant > None
        effective_text = override_text if override_text else variant_text

        # Фича 1: инъекция аудио имени (вариант произношения) между частями
        # фразы. Если у cue задан name_variant_key и для имени жертвы есть
        # аудио — собираем audio_segments [фраза_cue?, имя].
        name_audio = (
            (name_audio_by_variant or {}).get(cue.name_variant_key)
            if cue.name_variant_key
            else None
        )
        injected_segments: list[dict[str, Any]] | None = None
        if name_audio is not None:
            segments: list[dict[str, Any]] = []
            if variant_audio_url:
                segments.append(
                    {
                        "url": variant_audio_url,
                        "duration_ms": variant_duration_ms,
                    }
                )
            segments.append(
                {
                    "url": f"/audio/{name_audio.storage_path}",
                    "duration_ms": name_audio.duration_ms,
                }
            )
            injected_segments = segments
            seg_total = sum(int(s["duration_ms"] or 0) for s in segments)
            effective_duration = (
                int(seg_total * multiplier) if multiplier != 1.0 else seg_total
            ) or None
            if target_player_name:
                effective_text = " ".join(
                    t for t in [effective_text, target_player_name] if t
                ).strip() or None

        post_pause = int(getattr(cue, "pause_after_ms", 0) or 0)
        if idx < total:
            post_pause += inter_cue_pause_ms
        item: dict[str, Any] = {
            # Стабильный уникальный идентификатор announcement'а (per-cue).
            # Фронт (useNarrationAudio / NarratorScreen / store dedup) завязан
            # на announcement.key, чтобы перезапускать аудио-эффект при смене
            # наррации внутри уже смонтированного NarratorScreen. Legacy-
            # наррации (narration_script.py) всегда отдают key; Story Engine
            # раньше его не слал → вторая и последующие наррации фазы шли с
            # key=null, useNarrationAudio не перезапускал эффект и аудио немело.
            "key": str(cue.id),
            "step_index": idx,
            "steps_total": total,
            "trigger": trigger_slug,
            "text": effective_text,
            "duration_ms": effective_duration,
            "karaoke": karaoke,
            "post_pause_ms": post_pause,
        }
        # Pre-fill audio (если есть вариант с файлом) — resolve_steps не
        # перезатрёт уже заполненные поля, если триггер не в манифесте.
        if injected_segments is not None:
            # Имя вставлено между фразами → отдаём audio_segments (фронт
            # проигрывает их последовательно), audio_url=None.
            item["audio_url"] = None
            item["audio_segments"] = injected_segments
        elif variant_audio_url:
            item["audio_url"] = variant_audio_url
            item["audio_file_name"] = variant_audio_filename
        items.append(item)
    return items


async def _load_effective_settings(
    db, session
) -> dict[str, Any]:
    """Загружает эффективные настройки сюжета для сессии.

    Алгоритм (этап 3):
    1. Базовые значения из ``StorySettings`` (per story_id) — если строка есть.
    2. Поверх — overrides из ``session.settings`` (jsonb): ``timer_multiplier``,
       ``inter_cue_pause_seconds``, ``karaoke_enabled``. None в overrides
       означает «использовать базовое».
    3. Финальные дефолты если ничего не нашли: karaoke=True, multiplier=1.0,
       pause=0.0 (зеркалит server_default из StorySettings).

    Возвращает dict {karaoke: bool, multiplier: float,
    inter_cue_pause_seconds: float}.
    """
    karaoke = True
    multiplier = 1.0
    pause_s = 0.0

    if session and session.story_id:
        settings_row = await db.scalar(
            select(StorySettings).where(StorySettings.story_id == session.story_id)
        )
        if settings_row is not None:
            karaoke = bool(settings_row.karaoke_enabled)
            try:
                multiplier = float(settings_row.timer_multiplier_default)
            except (TypeError, ValueError):
                multiplier = 1.0
            try:
                pause_s = float(settings_row.inter_cue_pause_seconds)
            except (TypeError, ValueError):
                pause_s = 0.0

    overrides = (session.settings or {}) if session else {}
    if overrides.get("timer_multiplier") is not None:
        try:
            multiplier = float(overrides["timer_multiplier"])
        except (TypeError, ValueError):
            pass
    if overrides.get("inter_cue_pause_seconds") is not None:
        try:
            pause_s = float(overrides["inter_cue_pause_seconds"])
        except (TypeError, ValueError):
            pass

    return {
        "karaoke": karaoke,
        "multiplier": multiplier,
        "inter_cue_pause_seconds": pause_s,
    }


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

    Этап 3: длительность умножается на effective timer_multiplier — если
    хост ускорил/замедлил всё в 2 раза, паузы тоже масштабируются.
    """
    duration_ms = int(step.payload.get("duration_ms", 1000))
    if duration_ms <= 0:
        return
    # Локальный импорт чтобы не тянуть game_engine в test env без БД.
    from services.game_engine import _wait_or_pause

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        eff = await _load_effective_settings(db, session)
    scaled_ms = int(duration_ms * eff["multiplier"])
    if scaled_ms <= 0:
        return
    await _wait_or_pause(session_id, scaled_ms / 1000)


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
# Handlers — gameplay (этапы 2.3-2.4)
# ============================================================================

# Маппинг role_slug → action_type для action_required WS.
# Используется в _handle_role_action когда payload не задаёт action_type явно.
_ROLE_TO_ACTION_TYPE: dict[str, str] = {
    "mafia": "kill",
    "don": "don_check",
    "sheriff": "check",
    "doctor": "heal",
    "lover": "lover_visit",
    "maniac": "maniac_kill",
}


async def _handle_role_action(session_id: uuid.UUID, step: StoryStep) -> None:
    """Один ночной ход роли.

    step.payload:
      - role_slug: str (обязательно) — какая роль ходит
      - action_type: str (опц.) — переопределяет дефолт из _ROLE_TO_ACTION_TYPE
      - timer_setting: str (опц.) — имя ключа в session.settings для таймера
        (default 'night_action_timer_seconds')
      - skip_if_dead: bool (default true) — пропустить ход если актёр мёртв
      - exclude_self_target: bool (default true)

    Логика:
      1. Найти живого actor с этой role_slug. Если skip_if_dead и actor мёртв
         (или его нет вовсе) — пропустить ход, advance дальше.
      2. Сформировать targets (все живые кроме self).
      3. Запустить timer, отправить action_required actor'у.
      4. Ждать night_action_event (или timeout). По событию — завершить.

    MVP-ограничения: один actor (для мафии берётся первый по join_order),
    нет lover_block, нет doctor heal history.
    """
    payload = step.payload or {}
    role_slug = payload.get("role_slug")
    if not role_slug:
        log_event(
            logger, logging.WARNING, "story_engine.role_action.no_role",
            "role_action step без role_slug — пропускаем",
            session_id=str(session_id), step_slug=step.slug,
        )
        return

    # Auto-transition: role_action идёт в night-phase.
    await _ensure_phase_for_step(session_id, expected_phase_type="night", via="auto_role_action")

    skip_if_dead = bool(payload.get("skip_if_dead", True))
    exclude_self = bool(payload.get("exclude_self_target", True))
    action_type = payload.get("action_type") or _ROLE_TO_ACTION_TYPE.get(role_slug)
    if action_type is None:
        log_event(
            logger, logging.WARNING, "story_engine.role_action.no_action_type",
            f"role={role_slug!r}: action_type не задан в payload и нет дефолта",
            session_id=str(session_id), step_slug=step.slug,
        )
        return

    timer_setting = payload.get("timer_setting") or "night_action_timer_seconds"

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        timer_seconds = int((session.settings or {}).get(timer_setting) or 30)

        # Все живые игроки, чтобы определить actor + targets.
        alive_players = (
            await db.scalars(
                select(Player)
                .options(selectinload(Player.role), selectinload(Player.user))
                .where(Player.session_id == session_id, Player.status == "alive")
                .order_by(Player.join_order)
            )
        ).all()

        actor: Player | None = next(
            (p for p in alive_players if p.role and p.role.slug == role_slug),
            None,
        )

        if actor is None and skip_if_dead:
            log_event(
                logger, logging.INFO, "story_engine.role_action.skipped",
                "Actor with role is dead/missing — skipping turn",
                session_id=str(session_id), role_slug=role_slug,
            )
            return

        # available_targets: все живые кроме самого actor (если exclude_self).
        target_players = [
            p for p in alive_players
            if not exclude_self or (actor is None or p.id != actor.id)
        ]
        targets = [_player_target_dict(p) for p in target_players]

        # Текущая фаза для phase_payload.
        phase = await _get_current_phase(db, session_id)
        if phase is None:
            return

        rt = runtime_state.get(session_id)
        rt.timer_name = f"night_{role_slug}"
        rt.timer_seconds = timer_seconds
        rt.timer_started_at = utc_now()
        rt.night_turn = role_slug
        rt.night_action_event.clear()

        # WS phase_changed с timer state — фронт обновит таймер.
        phase_payload = {
            "phase": {"type": phase.phase_type, "number": phase.phase_number},
            "sub_phase": None,
            "night_turn": role_slug,
            "timer_name": rt.timer_name,
            "timer_seconds": timer_seconds,
            "timer_started_at": rt.timer_started_at.isoformat(),
        }
        await _emit_phase_changed(session_id, phase_payload, db=db, phase_id=phase.id)

        # action_required только если есть живой actor.
        if actor is not None:
            await ws_manager.send_to_user(
                session_id,
                actor.user_id,
                {
                    "type": "action_required",
                    "payload": {
                        "action_type": action_type,
                        "available_targets": targets,
                        "timer_seconds": timer_seconds,
                        "timer_started_at": rt.timer_started_at.isoformat(),
                    },
                },
            )

    # Timer callback: по таймауту шлём action_timeout и снимаем event.
    async def _on_timeout() -> None:
        await ws_manager.send_to_session(
            session_id,
            {"type": "action_timeout", "payload": {"action_type": action_type}},
        )
        rt = runtime_state.get(session_id)
        rt.night_action_event.set()

    await timer_service.start_timer(session_id, rt.timer_name, timer_seconds, _on_timeout)
    await rt.night_action_event.wait()
    await timer_service.cancel_timer(session_id, rt.timer_name)
    rt.night_action_event.clear()

    rt.timer_name = None
    rt.timer_seconds = None
    rt.timer_started_at = None
    rt.night_turn = None


async def _handle_discussion(session_id: uuid.UUID, step: StoryStep) -> None:
    """Дневная дискуссия — просто таймер на discussion_timer_seconds.

    step.payload.timer_setting (default 'discussion_timer_seconds').
    Фронт получает phase_changed с sub_phase='discussion' + timer info.
    По окончании timer — handler возвращается, executor advance'ит.

    Auto-transition: если текущая фаза не 'day' (например, story стартовал
    с narration в role_reveal и сразу попал на discussion без явного
    phase_action: enter_day), автоматически создаём GamePhase day. Без этого
    фронт остаётся на role_reveal-screen и показывает карточки ролей вместо
    discussion screen.
    """
    payload = step.payload or {}
    timer_setting = payload.get("timer_setting") or "discussion_timer_seconds"

    await _ensure_phase_for_step(session_id, expected_phase_type="day", via="auto_discussion")

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        timer_seconds = int((session.settings or {}).get(timer_setting) or 60)
        phase = await _get_current_phase(db, session_id)
        if phase is None:
            return

        rt = runtime_state.get(session_id)
        rt.timer_name = "discussion"
        rt.timer_seconds = timer_seconds
        rt.timer_started_at = utc_now()

        phase_payload = {
            "phase": {"type": phase.phase_type, "number": phase.phase_number},
            "sub_phase": "discussion",
            "timer_name": "discussion",
            "timer_seconds": timer_seconds,
            "timer_started_at": rt.timer_started_at.isoformat(),
        }
        await _emit_phase_changed(session_id, phase_payload, db=db, phase_id=phase.id)

    # Ждём окончания таймера через _wait_or_pause (учитывает паузу).
    from services.game_engine import _wait_or_pause
    await _wait_or_pause(session_id, timer_seconds)

    rt.timer_name = None
    rt.timer_seconds = None
    rt.timer_started_at = None


async def _handle_voting(session_id: uuid.UUID, step: StoryStep) -> None:
    """Голосование. Один раунд (MVP).

    step.payload.timer_setting (default 'voting_timer_seconds').
    Голоса собираются через POST /api/sessions/{id}/vote (legacy endpoint
    пишет в DayVote). По окончании timer — handler возвращается, day_resolve
    подсчитает.

    Auto-transition: аналогично discussion, voting должен идти в day-phase.
    """
    payload = step.payload or {}
    timer_setting = payload.get("timer_setting") or "voting_timer_seconds"

    await _ensure_phase_for_step(session_id, expected_phase_type="day", via="auto_voting")

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        timer_seconds = int((session.settings or {}).get(timer_setting) or 30)
        phase = await _get_current_phase(db, session_id)
        if phase is None:
            return

        rt = runtime_state.get(session_id)
        rt.timer_name = "voting"
        rt.timer_seconds = timer_seconds
        rt.timer_started_at = utc_now()

        phase_payload = {
            "phase": {"type": phase.phase_type, "number": phase.phase_number},
            "sub_phase": "voting",
            "timer_name": "voting",
            "timer_seconds": timer_seconds,
            "timer_started_at": rt.timer_started_at.isoformat(),
        }
        await _emit_phase_changed(session_id, phase_payload, db=db, phase_id=phase.id)

    from services.game_engine import _wait_or_pause
    await _wait_or_pause(session_id, timer_seconds)

    rt.timer_name = None
    rt.timer_seconds = None
    rt.timer_started_at = None


async def _handle_night_resolve(session_id: uuid.UUID, step: StoryStep) -> None:
    """Подсчёт ночных жертв БЕЗ narration (narration делается отдельным
    narration-шагом ``night_result``).

    Логика (упрощённая копия ``game_engine.resolve_night`` без WS/narration):
    - Собираем NightAction по фазе: kill, maniac_kill, heal, lover_visit.
    - Целевые жертвы = (kill ∪ maniac_kill) \\ healed.
    - Если lover увёл цель — атаки на неё блокируются (was_blocked=True).
    - Применяем status='dead' к жертвам, шлём WS player_eliminated.
    - Обновляем step_vars: died_role (если одна жертва), death_cause='night',
      phase_number, alive_roles, winner_team.
    """
    from services.game_engine import check_win_condition

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        phase = await _get_current_phase(db, session_id)
        if phase is None or phase.phase_type != "night":
            return

        mafia_action = await db.scalar(
            select(NightAction).where(
                NightAction.phase_id == phase.id,
                NightAction.action_type == "kill",
            )
        )
        maniac_action = await db.scalar(
            select(NightAction).where(
                NightAction.phase_id == phase.id,
                NightAction.action_type == "maniac_kill",
            )
        )
        doctor_action = await db.scalar(
            select(NightAction).where(
                NightAction.phase_id == phase.id,
                NightAction.action_type == "heal",
            )
        )
        lover_action = await db.scalar(
            select(NightAction).where(
                NightAction.phase_id == phase.id,
                NightAction.action_type == "lover_visit",
            )
        )

        attack_targets: set[uuid.UUID] = set()
        if mafia_action and not mafia_action.was_blocked:
            attack_targets.add(mafia_action.target_player_id)
        if maniac_action and not maniac_action.was_blocked:
            attack_targets.add(maniac_action.target_player_id)

        healed_id = doctor_action.target_player_id if doctor_action else None
        lover_target_id = lover_action.target_player_id if lover_action else None

        if lover_target_id is not None and lover_target_id in attack_targets:
            attack_targets.discard(lover_target_id)

        if healed_id is not None and healed_id in attack_targets:
            attack_targets.discard(healed_id)

        died_role: str | None = None
        died_count = 0
        died_names: list[str] = []
        for tid in attack_targets:
            target = await db.scalar(
                select(Player).options(selectinload(Player.role)).where(Player.id == tid)
            )
            if target and target.status == "alive":
                target.status = "dead"
                died_count += 1
                died_names.append(target.name)
                if died_count == 1 and target.role:
                    died_role = target.role.slug
                elif died_count > 1:
                    died_role = None  # mass death — не привязываем к конкретной роли
                db.add(
                    GameEvent(
                        id=uuid.uuid4(),
                        session_id=session_id,
                        phase_id=phase.id,
                        event_type="player_eliminated",
                        payload={
                            "player_id": str(target.id),
                            "name": target.name,
                            "cause": "night",
                            "role_slug": target.role.slug if target.role else None,
                        },
                    )
                )
                await ws_manager.send_to_session(
                    session_id,
                    {
                        "type": "player_eliminated",
                        "payload": {
                            "player_id": str(target.id),
                            "name": target.name,
                            "cause": "night",
                        },
                    },
                )

        # Закрываем ночную фазу.
        if phase.ended_at is None:
            phase.ended_at = utc_now()
        await db.commit()

        await _refresh_step_vars(
            db,
            session_id,
            phase_number=phase.phase_number,
            death_cause="night",
            died_role=died_role,
            died_name=died_names[0] if len(died_names) == 1 else None,
        )
        winner = await check_win_condition(db, session_id)
        if winner is not None:
            await _set_step_var(db, session_id, "winner_team", winner)


async def _handle_day_resolve(session_id: uuid.UUID, step: StoryStep) -> None:
    """Резолв голосования. MVP: подсчёт голосов из DayVote, изгнание игрока
    с большинством, обновление step_vars.

    После day_resolve записывает в step_vars:
      - phase_number
      - died_role: str | null
      - death_cause: 'vote'
      - vote_tie: bool
      - winner_team: str | null
      - alive_roles
    """
    from services.game_engine import check_win_condition

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        phase = await _get_current_phase(db, session_id)
        if phase is None or phase.phase_type != "day":
            return

        # Подсчёт голосов: target_player_id → count, исключая abstain.
        votes = (
            await db.scalars(
                select(DayVote).where(
                    DayVote.phase_id == phase.id,
                    DayVote.target_player_id.is_not(None),
                )
            )
        ).all()
        tally: dict[uuid.UUID, int] = {}
        for v in votes:
            tally[v.target_player_id] = tally.get(v.target_player_id, 0) + 1

        died_role: str | None = None
        vote_tie = False
        eliminated_name: str | None = None
        if tally:
            max_count = max(tally.values())
            leaders = [tid for tid, c in tally.items() if c == max_count]
            if len(leaders) == 1:
                # Изгнан игрок с большинством.
                eliminated = await db.scalar(
                    select(Player)
                    .options(selectinload(Player.role))
                    .where(Player.id == leaders[0])
                )
                if eliminated and eliminated.status == "alive":
                    eliminated.status = "dead"
                    died_role = eliminated.role.slug if eliminated.role else None
                    eliminated_name = eliminated.name
                    db.add(
                        GameEvent(
                            id=uuid.uuid4(),
                            session_id=session_id,
                            phase_id=phase.id,
                            event_type="player_eliminated",
                            payload={
                                "player_id": str(eliminated.id),
                                "name": eliminated.name,
                                "cause": "vote",
                                "role_slug": died_role,
                            },
                        )
                    )
                    await ws_manager.send_to_session(
                        session_id,
                        {
                            "type": "player_eliminated",
                            "payload": {
                                "player_id": str(eliminated.id),
                                "name": eliminated.name,
                                "cause": "vote",
                            },
                        },
                    )
            else:
                vote_tie = True

        # Закрываем фазу day.
        if phase.ended_at is None:
            phase.ended_at = utc_now()
        await db.commit()

        await _refresh_step_vars(
            db,
            session_id,
            phase_number=phase.phase_number,
            death_cause="vote",
            died_role=died_role,
            vote_tie=vote_tie,
            died_name=eliminated_name,
        )
        winner = await check_win_condition(db, session_id)
        if winner is not None:
            await _set_step_var(db, session_id, "winner_team", winner)


# ============================================================================
# Helpers: phase actions, step_vars, current phase
# ============================================================================


async def _apply_phase_action(session_id: uuid.UUID, step: StoryStep) -> None:
    """Применяет step.payload.phase_action: создаёт новую GamePhase.

    Допустимые значения:
      - 'enter_night': новая phase night, phase_number = step_vars.phase_number + 1
        (или 1 если ещё нет). Записывает phase_number в step_vars.
      - 'enter_day':   новая phase day, phase_number = current night.phase_number.
      - 'enter_finished': sessions.status = 'finished'. (Финальный exit step
        тоже шлёт game_finished, но enter_finished нужен ДО ending narration.)

    Если phase_action не задан — no-op. Дублирующая фаза (та же type+number
    уже есть) — игнорируется (idempotent на случай recovery).
    """
    payload = step.payload or {}
    action = payload.get("phase_action")
    if not action:
        return

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return

        if action == "enter_finished":
            session.status = "finished"
            session.ended_at = utc_now()
            current = await _get_current_phase(db, session_id)
            if current and current.ended_at is None:
                current.ended_at = session.ended_at
            await db.commit()
            return

        # Определяем next phase_type + phase_number.
        state = await _load_state(db, session_id)
        current_phase_number: int = 0
        if state and state.step_vars:
            current_phase_number = int(state.step_vars.get("phase_number") or 0)

        if action == "enter_night":
            next_type = "night"
            next_number = current_phase_number + 1
        elif action == "enter_day":
            next_type = "day"
            next_number = current_phase_number  # тот же номер что и ночь
        else:
            log_event(
                logger, logging.WARNING, "story_engine.unknown_phase_action",
                f"Unknown phase_action: {action!r}",
                session_id=str(session_id), step_slug=step.slug,
            )
            return

        # Проверка идемпотентности: дублирующая фаза уже существует?
        dup = await db.scalar(
            select(GamePhase.id).where(
                GamePhase.session_id == session_id,
                GamePhase.phase_type == next_type,
                GamePhase.phase_number == next_number,
            )
        )
        if dup is not None:
            log_event(
                logger, logging.INFO, "story_engine.phase_dup_skipped",
                "Phase already exists, skipping creation",
                session_id=str(session_id),
                phase_type=next_type, phase_number=next_number,
            )
            # Всё равно обновим step_vars, чтобы условия видели актуальный номер.
            if state:
                vars = dict(state.step_vars or {})
                vars["phase_number"] = next_number
                state.step_vars = vars
                await db.commit()
            return

        # Закрыть текущую фазу.
        current = await _get_current_phase(db, session_id)
        if current and current.ended_at is None:
            current.ended_at = utc_now()

        new_phase = GamePhase(
            id=uuid.uuid4(),
            session_id=session_id,
            phase_type=next_type,
            phase_number=next_number,
            started_at=utc_now(),
            ended_at=None,
        )
        db.add(new_phase)

        # Обновим step_vars.phase_number.
        if state:
            vars = dict(state.step_vars or {})
            vars["phase_number"] = next_number
            state.step_vars = vars

        await db.commit()

        # WS phase_changed.
        phase_payload = {
            "phase": {"type": next_type, "number": next_number},
            "sub_phase": None,
            "timer_seconds": None,
            "timer_started_at": None,
        }
        await _emit_phase_changed(
            session_id, phase_payload, db=db, phase_id=new_phase.id
        )
        log_event(
            logger, logging.INFO, "story_engine.phase_entered",
            "Story Engine created new GamePhase",
            session_id=str(session_id),
            phase_type=next_type, phase_number=next_number,
            via=action,
        )


async def _refresh_step_vars(
    db: AsyncSession,
    session_id: uuid.UUID,
    *,
    phase_number: int,
    death_cause: str,
    died_role: str | None = None,
    vote_tie: bool = False,
    died_name: str | None = None,
) -> None:
    """Обновляет step_vars после night_resolve / day_resolve.

    Считает alive_roles из БД (slug-и живых ролей) для условий role_alive/dead.
    ``died_name`` — имя единственной жертвы (для инъекции варианта произношения
    имени в последующих narration-cue с ``name_variant_key``).
    """
    state = await _load_state(db, session_id)
    if state is None:
        return
    alive_role_slugs = (
        await db.scalars(
            select(Role.slug)
            .join(Player, Player.role_id == Role.id)
            .where(Player.session_id == session_id, Player.status == "alive")
            .distinct()
        )
    ).all()
    vars = dict(state.step_vars or {})
    vars["phase_number"] = phase_number
    vars["death_cause"] = death_cause
    vars["died_role"] = died_role
    vars["vote_tie"] = vote_tie
    vars["died_player_name"] = died_name
    vars["alive_roles"] = sorted(set(alive_role_slugs))
    state.step_vars = vars
    await db.commit()


async def _set_step_var(
    db: AsyncSession, session_id: uuid.UUID, key: str, value: Any
) -> None:
    state = await _load_state(db, session_id)
    if state is None:
        return
    vars = dict(state.step_vars or {})
    vars[key] = value
    state.step_vars = vars
    await db.commit()


async def _get_current_phase(
    db: AsyncSession, session_id: uuid.UUID
) -> GamePhase | None:
    """Локальная копия get_current_phase из game_engine — без import-cycle."""
    return await db.scalar(
        select(GamePhase)
        .where(GamePhase.session_id == session_id, GamePhase.ended_at.is_(None))
        .order_by(GamePhase.started_at.desc())
        .limit(1)
    )


async def _ensure_phase_for_step(
    session_id: uuid.UUID,
    expected_phase_type: str,
    *,
    via: str,
) -> None:
    """Авто-транзишн в expected_phase_type если текущая фаза другая.

    Используется handler'ами discussion/voting/role_action чтобы сюжетный
    flow не падал, если автор сценария забыл явно добавить step с
    phase_action: enter_day/enter_night.

    Логика:
      - Если текущая фаза уже expected_phase_type — no-op.
      - Если нет — закрываем текущую (ставим ended_at) и создаём новую
        GamePhase того же phase_number (или 1 если ещё не было).
      - Шлём phase_changed чтобы фронт переключил deriveScreen.

    Идемпотентен на случай recovery: если фаза уже создана с тем же type+number,
    просто пропускаем.
    """
    async with async_session_factory() as db:
        current = await _get_current_phase(db, session_id)
        if current is not None and current.phase_type == expected_phase_type:
            return  # уже в нужной фазе

        # Определяем phase_number: для day берём номер ночи, для night +1.
        # Для простоты: если перешли из role_reveal сразу в day — phase_number=1.
        state = await _load_state(db, session_id)
        current_phase_number = 0
        if state and state.step_vars:
            current_phase_number = int(state.step_vars.get("phase_number") or 0)

        if expected_phase_type == "day":
            next_number = max(current_phase_number, 1)
        elif expected_phase_type == "night":
            next_number = current_phase_number + 1
        else:
            next_number = current_phase_number or 1

        # Идемпотентность: если такая фаза уже существует — переиспользуем.
        existing = await db.scalar(
            select(GamePhase).where(
                GamePhase.session_id == session_id,
                GamePhase.phase_type == expected_phase_type,
                GamePhase.phase_number == next_number,
            )
        )
        if existing is not None:
            # Если она закрыта — переоткрываем (ended_at = None). Иначе просто
            # выходим: всё уже как надо.
            if existing.ended_at is not None:
                existing.ended_at = None
                await db.commit()
            return

        # Закрываем текущую фазу.
        if current is not None and current.ended_at is None:
            current.ended_at = utc_now()

        new_phase = GamePhase(
            id=uuid.uuid4(),
            session_id=session_id,
            phase_type=expected_phase_type,
            phase_number=next_number,
            started_at=utc_now(),
            ended_at=None,
        )
        db.add(new_phase)

        if state:
            vars = dict(state.step_vars or {})
            vars["phase_number"] = next_number
            state.step_vars = vars

        await db.commit()

        phase_payload = {
            "phase": {"type": expected_phase_type, "number": next_number},
            "sub_phase": None,
            "timer_seconds": None,
            "timer_started_at": None,
        }
        await _emit_phase_changed(
            session_id, phase_payload, db=db, phase_id=new_phase.id
        )
        log_event(
            logger, logging.INFO, "story_engine.phase_auto_entered",
            "Story Engine auto-transitioned phase",
            session_id=str(session_id),
            phase_type=expected_phase_type, phase_number=next_number,
            via=via,
        )


def _player_target_dict(p: Player) -> dict[str, str]:
    """Сериализация Player для available_targets WS-payload.

    Дублирует helper из game_engine чтобы избежать import-cycle.
    """
    return {"player_id": str(p.id), "name": p.name}


async def _emit_phase_changed(
    session_id: uuid.UUID,
    payload: dict,
    *,
    db: AsyncSession | None = None,
    phase_id: uuid.UUID | None = None,
) -> None:
    """Тонкая обёртка над WS phase_changed + опциональный persist GameEvent.

    Для Story Engine не нужен heavy _emit_phase_changed из game_engine
    (он управляет current_announcement; у нас announcement в narration handler).
    """
    log_event(
        logger, logging.INFO, "story_engine.phase_changed",
        "Story Engine emit phase_changed",
        session_id=str(session_id),
        phase=payload.get("phase"),
        sub_phase=payload.get("sub_phase"),
        night_turn=payload.get("night_turn"),
    )
    await ws_manager.send_to_session(
        session_id, {"type": "phase_changed", "payload": payload}
    )
    if db is not None and phase_id is not None:
        db.add(
            GameEvent(
                id=uuid.uuid4(),
                session_id=session_id,
                phase_id=phase_id,
                event_type="phase_changed",
                payload=payload,
            )
        )
        await db.commit()


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
