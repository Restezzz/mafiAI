"""Игровой движок (server-side источник истины).

Отвечает за:
- переходы фаз (role_reveal -> night -> day discussion -> day voting -> night ...)
- таймеры (через `services/timer_service.py`)
- запись событий в `game_events` для восстановления состояния после реконнекта/рестарта
- WS push-события участникам с `announcement.trigger` для локальной озвучки на клиенте
"""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from datetime import datetime

from sqlalchemy import String, cast, delete, exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.exceptions import GameError
from core.logging import log_event
from core.utils import utc_now
from models.game_event import GameEvent
from models.game_phase import GamePhase
from models.night_action import NightAction
from models.day_vote import DayVote
from models.player import Player
from models.role import Role
from models.session import Session
from models.story import StoryName, StoryRoleOverride
from services.narration_script import (
    all_acknowledged_steps,
    day_discussion_steps,
    day_voting_steps,
    game_finished_steps,
    game_started_steps,
    night_result_steps,
    night_start_steps,
    turn_intro_steps,
    turn_outro_steps,
    vote_result_steps,
    vote_tie_steps,
)
from services.narration_audio import resolve_steps
from services.audio_manifest import get_manifest as get_audio_manifest
from services.audio_preload import ensure_audio_preload_ready
from services.timer_service import timer_service
from services.runtime_state import runtime_state
from services.ws_manager import ws_manager

logger = logging.getLogger(__name__)


def _role_config(session: Session) -> dict:
    return (session.settings or {}).get("role_config") or {}


def _player_target_dict(p: Player) -> dict:
    """Сериализация игрока для available_targets / *_eliminated WS-событий.

    Возвращает payload вида ``{player_id, name, username}``, где ``username`` —
    это никнейм аккаунта (``User.display_name``). Фронт показывает его второй
    строкой под именем персонажа в меню голосования и ночных ролей.

    Требует, чтобы ``Player`` был загружен с ``selectinload(Player.user)``.
    Иначе обращение к ``p.user`` сделает ленивый sync-запрос и упадёт в
    async-контексте (``MissingGreenlet``).
    """
    user = getattr(p, "user", None)
    return {
        "player_id": str(p.id),
        "name": p.name,
        "username": user.display_name if user is not None else None,
    }


async def _allowed_player_names(db: AsyncSession, session: Session) -> set[str]:
    """Пул допустимых имён игроков.

    Источник — собственный набор имён выбранного сюжета (``story_names``). Если
    у сюжета нет своих имён (или сюжет не выбран) — фолбэк на глобальный
    манифест озвучки.
    """
    if session.story_id is not None:
        rows = await db.scalars(
            select(StoryName.display_name).where(
                StoryName.story_id == session.story_id
            )
        )
        names = {n for n in rows.all() if n}
        if names:
            return names
    return set(get_audio_manifest().display_names())


async def _autofill_unselected_names(
    db: AsyncSession,
    session: Session,
    players: list[Player],
) -> list[Player]:
    """Назначает рандомное озвученное имя игрокам, не выбравшим имя из манифеста.

    Сценарии срабатывания:

    * Игрок не успел нажать кнопку имени за отведённый таймер ``name-pick``-фазы
      — у него остаётся плейсхолдерное имя из лобби (``"Игрок 3"``), которого
      нет в озвучке. Без авто-замены ведущий не сможет произнести имя в
      ночных/дневных нарративах.
    * Dev-test ``боты`` создаются с именами вида ``"Игрок 2"`` и не имеют
      открытой вкладки, чтобы выбрать имя самостоятельно.

    Список свободных имён формируется как ``manifest.display_names() − {имена,
    которые уже выбрали другие игроки и которые валидны}``. Имена раздаются
    случайно, чтобы не давать ботам всегда первые позиции из манифеста.

    Возвращает список игроков, которым было назначено новое имя — caller
    должен закоммитить транзакцию и отправить им WS ``player_renamed``.
    """
    allowed = await _allowed_player_names(db, session)
    if not allowed:
        return []

    taken = {p.name for p in players if p.name in allowed}
    needs_rename = [p for p in players if p.name not in allowed]
    if not needs_rename:
        return []

    available = [n for n in allowed if n not in taken]
    random.shuffle(available)

    changed: list[Player] = []
    for p in needs_rename:
        if not available:
            # Манифест содержит ~20 имён; для нормальных партий ветка
            # недостижима. Защищаемся, чтобы не упасть на edge-кейсе.
            break
        new_name = available.pop()
        old_name = p.name
        p.name = new_name
        db.add(
            GameEvent(
                id=uuid.uuid4(),
                session_id=session.id,
                phase_id=None,
                event_type="player_renamed",
                payload={"player_id": str(p.id), "name": new_name, "auto": True},
            )
        )
        changed.append(p)
        log_event(
            logger,
            logging.INFO,
            "session.player_auto_renamed",
            "Player auto-renamed at game start",
            session_id=str(session.id),
            player_id=str(p.id),
            old_name=old_name,
            new_name=new_name,
        )
    return changed


def _begin_phase_transition(session_id: uuid.UUID) -> None:
    rt = runtime_state.get(session_id)
    rt.phase_transition_depth += 1
    rt.phase_transition_running = True


def _end_phase_transition(session_id: uuid.UUID) -> None:
    rt = runtime_state.get(session_id)
    rt.phase_transition_depth = max(0, rt.phase_transition_depth - 1)
    if rt.phase_transition_depth == 0:
        rt.phase_transition_running = False


def _is_turn_enabled(session: Session, turn_slug: str) -> bool:
    cfg = _role_config(session)
    mapping = {
        "lover": int(cfg.get("lover", 0)) > 0,
        "mafia": int(cfg.get("mafia", 0)) > 0,
        "don": int(cfg.get("don", 0)) > 0,
        "sheriff": int(cfg.get("sheriff", 0)) > 0,
        "maniac": int(cfg.get("maniac", 0)) > 0,
        "doctor": int(cfg.get("doctor", 0)) > 0,
    }
    return mapping.get(turn_slug, False)


async def _wait_or_pause(session_id: uuid.UUID, seconds: float) -> None:
    """Ждать `seconds` секунд, учитывая паузу игры.

    Контракт:
    - Если игра НЕ на паузе — спим до истечения времени, прерываясь при наступлении паузы.
    - Если игра на паузе — ждём `resume_event.set()` и продолжаем счёт.
    - Время "съеденное" паузой НЕ считается за основу: возвращаемся только когда
      набрано суммарно `seconds` РЕАЛЬНОГО времени без паузы.

    Раньше polling'или флаг каждые 200ms; теперь `asyncio.wait_for` спит без CPU
    и просыпается мгновенно как только pause/resume событие set'ится.
    """
    rt = runtime_state.get(session_id)
    loop = asyncio.get_running_loop()
    remaining = float(seconds)
    while remaining > 0:
        # На паузе — ждём ресум перед тем как считать оставшееся время.
        if rt.game_paused:
            await rt.resume_event.wait()
        # Прерываемый sleep: возвращается либо по таймауту (тогда отсчёт закончен),
        # либо если кто-то set'нул pause_event (тогда продолжаем с уменьшенным remaining).
        start = loop.time()
        try:
            await asyncio.wait_for(rt.pause_event.wait(), timeout=remaining)
            # Сюда пришли только если пауза наступила. Уменьшаем remaining на
            # фактическое время сна и идём на следующую итерацию (там await resume).
            remaining -= loop.time() - start
        except asyncio.TimeoutError:
            # Дошли до конца без паузы.
            return


def _stamp_started_at(announcement: dict | None, ts=None) -> dict | None:
    """Добавляет ISO8601 `started_at` в копию announcement-payload.

    Нужен для синхронизации typewriter/прогресс-бара между клиентами и при reload —
    клиент сравнивает Date.now() с этой меткой, а не с моментом mount.
    Если started_at уже задан — возвращается без изменений.
    """
    if not announcement:
        return announcement
    if "started_at" in announcement and announcement["started_at"]:
        return announcement
    stamp = ts or utc_now()
    return {**announcement, "started_at": stamp.isoformat()}


async def _set_runtime_announcement(session_id: uuid.UUID, announcement: dict | None) -> dict | None:
    """Сохраняет announcement в runtime_state и возвращает его с заштампованным started_at."""
    rt = runtime_state.get(session_id)
    if announcement:
        stamped = _stamp_started_at(announcement)
        rt.current_announcement = stamped
        try:
            rt.announcement_started_at = datetime.fromisoformat(stamped["started_at"])
        except (ValueError, TypeError):
            rt.announcement_started_at = utc_now()
        return stamped
    rt.current_announcement = None
    rt.announcement_started_at = None
    return None


async def _emit_phase_changed(
    session_id: uuid.UUID,
    payload: dict,
    *,
    db: AsyncSession | None = None,
    phase_id: uuid.UUID | None = None,
    persist: bool = False,
) -> None:
    announcement = payload.get("announcement")
    is_blocking = bool(announcement and announcement.get("blocking", True))
    # Заштампуем started_at и для blocking, и для non-blocking — чтобы UI у всех клиентов
    # одинаково видел момент старта.
    stamped = await _set_runtime_announcement(session_id, announcement if is_blocking else None)
    if announcement and not is_blocking:
        stamped = _stamp_started_at(announcement)
    if stamped is not None:
        payload = {**payload, "announcement": stamped}
    if persist and db is not None and phase_id is not None:
        await _persist_phase_changed(db, session_id, phase_id, payload)
    log_event(
        logger,
        logging.INFO,
        "phase.changed",
        "Game phase changed",
        session_id=str(session_id),
        phase=payload.get("phase"),
        sub_phase=payload.get("sub_phase"),
        night_turn=payload.get("night_turn"),
    )
    await ws_manager.send_to_session(session_id, {"type": "phase_changed", "payload": payload})


def _gender_for_name(display_name: str | None) -> str | None:
    if not display_name:
        return None
    n = get_audio_manifest().name_by_display(display_name)
    return n.gender if n else None


# Запас в мс на каждую реплику. Длительности в audio_manifest.json
# теперь точные — читаются из mp3 через mutagen в build_audio_manifest.py,
# а не из `(N)` в имени. Поэтому grace нужен только как safety margin
# на сетевую задержку WebSocket'а между backend → frontend.
_ANNOUNCEMENT_GRACE_MS = 150


def _wait_seconds_for(announcement: dict | None) -> float:
    """Сколько ждать после WS-эмита announcement'а до следующего шага.

    Story Engine (этап 3) добавляет ``post_pause_ms`` к каждому cue (тихая
    пауза между фразами одного narration-step). Legacy путь не задаёт это
    поле, так что get(..., 0) — backward-compat.
    """
    a = announcement or {}
    duration_ms = a.get("duration_ms") or 0
    post_pause_ms = a.get("post_pause_ms") or 0
    if duration_ms <= 0 and post_pause_ms <= 0:
        return 0.0
    base = duration_ms + _ANNOUNCEMENT_GRACE_MS if duration_ms > 0 else 0
    return (base + post_pause_ms) / 1000


async def _play_phase_announcements(
    session_id: uuid.UUID,
    phase_payload: dict,
    steps: list[dict],
    *,
    db: AsyncSession | None = None,
    phase_id: uuid.UUID | None = None,
    persist: bool = False,
    target_player_name: str | None = None,
) -> None:
    """Прокручивает announcement'ы фазы.

    #8: раньше каждый announcement делал отдельный commit (для 5-шаговой фазы —
    5 round-trip'ов в БД). Теперь WS-сообщения отправляются сразу, а GameEvent'ы
    копятся и пишутся одним commit'ом в конце цикла.

    Trade-off: если backend упадёт между WS-сообщением и финальным commit'ом,
    /state у переподключившегося клиента покажет более ранний announcement
    (последний committed). Клиент быстро догонит из следующего phase_changed —
    допустимое compromise за -80% latency на старте каждой фазы.
    """
    target_gender = _gender_for_name(target_player_name)
    enriched = resolve_steps(
        steps,
        target_player_name=target_player_name,
        target_player_gender=target_gender,
    )
    should_persist = persist and db is not None and phase_id is not None
    pending_events: list[GameEvent] = []
    for announcement in enriched:
        full_payload = {**phase_payload, "announcement": announcement}
        # Эмитим WS без commit'а — persist=False даже если общий флаг True.
        # Сам phase_changed-event добавим в pending_events ниже после возможного
        # stamp'а started_at (он делается внутри _emit_phase_changed).
        emitted_payload = await _emit_phase_changed_for_batch(session_id, full_payload)
        if should_persist:
            pending_events.append(
                GameEvent(
                    id=uuid.uuid4(),
                    session_id=session_id,
                    phase_id=phase_id,
                    event_type="phase_changed",
                    payload=emitted_payload,
                )
            )
        await _wait_or_pause(session_id, _wait_seconds_for(announcement))
    # ONE commit вместо N — главное ускорение #8.
    if pending_events and db is not None:
        db.add_all(pending_events)
        await db.commit()
    await _set_runtime_announcement(session_id, None)


async def _emit_phase_changed_for_batch(
    session_id: uuid.UUID,
    payload: dict,
) -> dict:
    """Версия `_emit_phase_changed` без db.commit() — для batch-режима в #8.

    Делает то же что и `_emit_phase_changed(... persist=False)`: трансформирует
    payload (стамп started_at, обновление runtime announcement), отправляет WS,
    логирует. Возвращает трансформированный payload, чтобы вызывающий мог
    собрать GameEvent для batch INSERT'а.
    """
    announcement = payload.get("announcement")
    is_blocking = bool(announcement and announcement.get("blocking", True))
    stamped = await _set_runtime_announcement(session_id, announcement if is_blocking else None)
    if announcement and not is_blocking:
        stamped = _stamp_started_at(announcement)
    if stamped is not None:
        payload = {**payload, "announcement": stamped}
    log_event(
        logger,
        logging.INFO,
        "phase.changed",
        "Game phase changed",
        session_id=str(session_id),
        phase=payload.get("phase"),
        sub_phase=payload.get("sub_phase"),
        night_turn=payload.get("night_turn"),
    )
    await ws_manager.send_to_session(session_id, {"type": "phase_changed", "payload": payload})
    return payload


async def _persist_phase_changed(
    db: AsyncSession,
    session_id: uuid.UUID,
    phase_id: uuid.UUID,
    payload: dict,
) -> None:
    """Персистим phase_changed так, чтобы можно было восстановить подфазу/таймер/ночной ход."""
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

async def get_current_phase(db: AsyncSession, session_id: uuid.UUID) -> GamePhase | None:
    return await db.scalar(
        select(GamePhase)
        .where(GamePhase.session_id == session_id, GamePhase.ended_at.is_(None))
        .order_by(GamePhase.started_at.desc())
        .limit(1)
    )


async def check_win_condition(db: AsyncSession, session_id: uuid.UUID) -> str | None:
    """Проверка условий победы.

    Приоритет (порядок важен):
      1. Маньяк: жив ровно один маньяк и суммарно город+мафия <= 1.
      2. Мафия: маньяков нет, живой мафии >= живого города.
      3. Город: нет ни мафии, ни маньяков.
      Иначе — игра продолжается.

    #24: используем selectinload(Player.role) чтобы получить и игроков и их роли
    одним запросом (раньше было два: alive players + roles по in_(...)).
    """
    alive = (
        await db.scalars(
            select(Player)
            .options(selectinload(Player.role))
            .where(Player.session_id == session_id, Player.status == "alive")
        )
    ).all()
    if not alive:
        return None
    if all(p.role_id is None for p in alive):
        return None

    alive_mafia = sum(1 for p in alive if p.role and p.role.team == "mafia")
    alive_city = sum(1 for p in alive if p.role and p.role.team == "city")
    alive_maniac = sum(1 for p in alive if p.role and p.role.team == "maniac")

    # Маньяк остался в живых один против одного (или меньше).
    if alive_maniac == 1 and (alive_city + alive_mafia) <= 1:
        return "maniac"

    # Маньяков больше нет — обычная механика мафия vs город.
    if alive_maniac == 0 and alive_mafia == 0:
        return "city"
    if alive_maniac == 0 and alive_mafia >= alive_city:
        return "mafia"

    return None


_ROLE_SLOTS = ("mafia", "don", "sheriff", "doctor", "lover", "maniac", "civilian")


def _validate_start_config(session: Session, players: list[Player]) -> dict[str, int]:
    """Валидирует role_config против числа игроков. Возвращает счётчики ролей.

    Используется и в обычном старте, и перед голосованием за сюжет, чтобы
    хост получил ошибку конфигурации сразу, а не после голосования.
    """
    role_cfg = (session.settings or {}).get("role_config") or {}
    cfg = {slot: int(role_cfg.get(slot, 0)) for slot in _ROLE_SLOTS}

    total_special = sum(cfg.values())
    if len(players) < total_special:
        raise GameError(
            400, "insufficient_players", "Недостаточно игроков для выбранной конфигурации"
        )

    mafia_count = cfg["mafia"] + cfg["don"]
    city_count = len(players) - mafia_count - cfg["maniac"]
    if mafia_count >= city_count:
        raise GameError(
            400, "invalid_role_config", "Мафия должна быть строго меньше города"
        )
    return cfg


async def start_game(db: AsyncSession, session: Session) -> None:
    if session.status != "waiting":
        raise GameError(409, "game_already_started", "Игра уже началась")
    await _run_role_reveal(db, session)


async def _role_overrides_by_slug(
    db: AsyncSession, story_id: uuid.UUID | None
) -> dict[str, "StoryRoleOverride"]:
    """Карта role_slug -> StoryRoleOverride для сюжета (с подгруженными картинками).

    Пустая карта, если у сессии нет story_id. Используется чтобы добавить
    пер-сюжетный визуал роли (имя + 2 карточки) в WS role_assigned.
    """
    if story_id is None:
        return {}
    rows = (
        await db.scalars(
            select(StoryRoleOverride)
            .where(StoryRoleOverride.story_id == story_id)
            .options(
                selectinload(StoryRoleOverride.card_front_image),
                selectinload(StoryRoleOverride.card_back_image),
            )
        )
    ).all()
    return {o.role_slug: o for o in rows}


def _role_payload_with_override(
    role: Role, overrides_by_slug: dict[str, "StoryRoleOverride"]
) -> dict:
    """Сериализует роль для WS role_assigned, добавляя пер-сюжетный визуал.

    display_name/card_front_url/card_back_url повторяют формат из
    GET /state (api/routers/game.py), чтобы фронт обрабатывал их одинаково.
    """
    ov = overrides_by_slug.get(role.slug)
    return {
        "slug": role.slug,
        "name": role.name,
        "team": role.team,
        "abilities": role.abilities,
        "display_name": ov.display_name if ov and ov.display_name else role.name,
        "description": ov.description if ov and ov.description else None,
        "card_front_url": (
            f"/images/{ov.card_front_image.storage_path}"
            if ov and ov.card_front_image
            else None
        ),
        "card_back_url": (
            f"/images/{ov.card_back_image.storage_path}"
            if ov and ov.card_back_image
            else None
        ),
    }


async def _run_role_reveal(
    db: AsyncSession, session: Session, *, enforce_audio_ready: bool = True
) -> None:
    """Раздаёт роли, создаёт role_reveal фазу и рассылает WS.

    Выделено из ``start_game`` чтобы переиспользовать после голосования за
    сюжет (фаза ``story_vote`` → выбор story_id → role_reveal).

    ``enforce_audio_ready`` — жёсткая проверка готовности озвучки (поднимает 409,
    если не все игроки докачали). Включена для ручного старта хостом, где 409
    видит сам хост. На автоматическом пути (таймер ``name_pick`` истёк →
    ``resolve_name_pick``) проверку делаем best-effort: предзагрузка — лишь
    оптимизация (воспроизведение умеет тянуть файл из backend storage на лету),
    поэтому НЕ блокируем переход. Иначе исключение в фоновой задаче таймера
    оставляло сессию без активной фазы (name_pick уже закрыт) — отсюда «ошибка
    сервера» при обновлении страницы и зависание на выдаче ролей.
    """
    if enforce_audio_ready:
        await ensure_audio_preload_ready(db, session)
    else:
        try:
            await ensure_audio_preload_ready(db, session)
        except GameError as exc:
            log_event(
                logger,
                logging.WARNING,
                "role_reveal.audio_not_ready",
                "Proceeding to role_reveal despite audio not fully preloaded",
                session_id=str(session.id),
                detail=getattr(exc, "message", str(exc)),
            )

    players = list(
        (await db.scalars(select(Player).where(Player.session_id == session.id))).all()
    )
    # Кто не успел выбрать имя за таймер story-страницы (или dev-test бот без
    # вкладки) — получает рандомное имя из ещё не разобранных в манифесте,
    # чтобы озвучка нашла аудиофайл для его имени. WS-уведомления отправляем
    # после commit.
    auto_renamed = await _autofill_unselected_names(db, session, players)
    cfg = _validate_start_config(session, players)
    mafia = cfg["mafia"]
    don = cfg["don"]
    sheriff = cfg["sheriff"]
    doctor = cfg["doctor"]
    lover = cfg["lover"]
    maniac = cfg["maniac"]

    required_slugs = ["mafia", "don", "sheriff", "doctor", "lover", "maniac", "civilian"]
    roles = (await db.scalars(select(Role).where(Role.slug.in_(required_slugs)))).all()
    role_by_slug = {r.slug: r for r in roles}
    missing = [s for s in required_slugs if s not in role_by_slug]
    if missing:
        raise GameError(500, "internal_error", f"Не хватает ролей в БД: {', '.join(missing)}")

    role_pool = (
        ["mafia"] * mafia
        + ["don"] * don
        + ["sheriff"] * sheriff
        + ["doctor"] * doctor
        + ["lover"] * lover
        + ["maniac"] * maniac
        + ["civilian"] * (len(players) - mafia - don - sheriff - doctor - lover - maniac)
    )
    random.shuffle(role_pool)
    for p, slug in zip(players, role_pool, strict=False):
        p.role_id = role_by_slug[slug].id

    phase = GamePhase(
        id=uuid.uuid4(),
        session_id=session.id,
        phase_type="role_reveal",
        phase_number=0,
        started_at=utc_now(),
        ended_at=None,
    )
    db.add(phase)
    session.status = "active"

    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id,
            event_type="game_started",
            payload={"phase": {"type": "role_reveal", "number": 0}},
        )
    )
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "game.started",
        "Game start persisted",
        session_id=str(session.id),
        player_count=len(players),
    )

    # Сначала шлём авто-rename, чтобы фронт обновил имена игроков
    # ДО прихода game_started/role_assigned/phase_changed.
    for p in auto_renamed:
        await ws_manager.send_to_session(
            session.id,
            {
                "type": "player_renamed",
                "payload": {"player_id": str(p.id), "name": p.name, "auto": True},
            },
        )

    timer_seconds = int((session.settings or {}).get("role_reveal_timer_seconds") or 15)
    rt = runtime_state.get(session.id)
    rt.timer_name = "role_reveal"
    rt.timer_seconds = timer_seconds
    rt.timer_started_at = phase.started_at
    await ws_manager.send_to_session(
        session.id,
        {
            "type": "game_started",
            "payload": {
                "phase": {"type": "role_reveal", "number": 0},
                "timer_seconds": timer_seconds,
                "started_at": phase.started_at.isoformat(),
            },
        },
    )

    # Персонально роль (эфемерное)
    role_by_id = {v.id: v for v in role_by_slug.values()}
    # Фича 2: пер-сюжетный визуал роли (display_name + 2 карточки). Без него
    # фронт на role_reveal показывал дефолтную карточку/название из статического
    # каталога. Грузим оверрайды одним запросом и кладём в role_assigned.
    overrides_by_slug = await _role_overrides_by_slug(db, session.story_id)
    await asyncio.gather(*(
        ws_manager.send_to_user(
            session.id,
            p.user_id,
            {
                "type": "role_assigned",
                "payload": {
                    "role": _role_payload_with_override(
                        role_by_id[p.role_id], overrides_by_slug
                    )
                },
            },
        )
        for p in players
    ))

    async def _on_role_reveal_timeout():
        # Запускаем как отдельную фоновую задачу, чтобы не блокировать
        # колбэк таймера собственным await-циклом execute_night_sequence.
        asyncio.create_task(_enter_first_night_or_story(session.id))

    await timer_service.start_timer(session.id, "role_reveal", timer_seconds, _on_role_reveal_timeout)


# ----------------------------------------------------------------------------
# Фича 3: голосование за сюжет (фаза story_vote перед role_reveal).
# ----------------------------------------------------------------------------

STORY_VOTE_DEFAULT_TIMER = 30


async def _votable_stories(db: AsyncSession) -> list[Story]:
    """Активные не-obsolete сюжеты для голосования (с обложкой)."""
    from models.story import Story as _Story

    return list(
        (
            await db.scalars(
                select(_Story)
                .where(_Story.is_active.is_(True), _Story.is_obsolete.is_(False))
                .options(selectinload(_Story.cover_image))
                .order_by(_Story.slug)
            )
        ).all()
    )


def _story_vote_card(s: "Story") -> dict:
    cover = getattr(s, "cover_image", None)
    return {
        "id": str(s.id),
        "slug": s.slug,
        "name": s.name,
        "description": s.description,
        "cover_url": f"/images/{cover.storage_path}" if cover else None,
        "cover_crop": s.cover_crop,
    }


async def _tally_story_votes(
    db: AsyncSession, session_id: uuid.UUID, phase_id: uuid.UUID
) -> tuple[dict[str, int], int]:
    """Считает голоса (последний голос игрока учитывается один раз).

    Возвращает ``({story_id: count}, voted_players)``.
    """
    events = (
        await db.scalars(
            select(GameEvent)
            .where(
                GameEvent.session_id == session_id,
                GameEvent.phase_id == phase_id,
                GameEvent.event_type == "story_vote",
            )
            .order_by(GameEvent.created_at)
        )
    ).all()
    by_player: dict[str, str] = {}
    for ev in events:
        pid = (ev.payload or {}).get("player_id")
        sid = (ev.payload or {}).get("story_id")
        if pid and sid:
            by_player[pid] = sid
    counts: dict[str, int] = {}
    for sid in by_player.values():
        counts[sid] = counts.get(sid, 0) + 1
    return counts, len(by_player)


async def start_story_vote(db: AsyncSession, session: Session) -> dict:
    """Запускает фазу голосования за сюжет вместо немедленного role_reveal.

    Если votable-сюжетов <=1 — голосовать не за что: фиксируем единственный
    (или None) и сразу раздаём роли.
    """
    if session.status != "waiting":
        raise GameError(409, "game_already_started", "Игра уже началась")

    players = list(
        (await db.scalars(select(Player).where(Player.session_id == session.id))).all()
    )
    _validate_start_config(session, players)

    stories = await _votable_stories(db)
    if len(stories) <= 1:
        session.story_id = stories[0].id if stories else None
        session.status = "active"
        await db.commit()
        await start_name_pick(db, session)
        return {"status": "active", "phase": {"type": "name_pick", "number": 0}}

    phase = GamePhase(
        id=uuid.uuid4(),
        session_id=session.id,
        phase_type="story_vote",
        phase_number=0,
        started_at=utc_now(),
        ended_at=None,
    )
    db.add(phase)
    session.status = "active"
    session.story_id = None
    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id,
            event_type="story_vote_started",
            payload={"phase": {"type": "story_vote", "number": 0}},
        )
    )
    await db.commit()

    timer_seconds = int(
        (session.settings or {}).get("story_vote_timer_seconds")
        or STORY_VOTE_DEFAULT_TIMER
    )
    rt = runtime_state.get(session.id)
    rt.timer_name = "story_vote"
    rt.timer_seconds = timer_seconds
    rt.timer_started_at = phase.started_at

    # Персистим phase_changed, чтобы таймер фазы восстанавливался из БД
    # (restore_runtime_like_fields). Без этого recovery_loop затирает
    # runtime-таймер в None, а пауза снимает снапшот с remaining=None →
    # после resume время «скачет» на 00:01 и /state падает.
    await _persist_phase_changed(
        db,
        session.id,
        phase.id,
        {
            "phase": {"type": "story_vote", "number": 0},
            "timer_name": "story_vote",
            "timer_seconds": timer_seconds,
            "timer_started_at": phase.started_at.isoformat(),
        },
    )

    await ws_manager.send_to_session(
        session.id,
        {
            "type": "phase_changed",
            "payload": {
                "phase": {"type": "story_vote", "number": 0},
                "timer_seconds": timer_seconds,
                "timer_started_at": phase.started_at.isoformat(),
                "stories": [_story_vote_card(s) for s in stories],
            },
        },
    )

    async def _on_story_vote_timeout():
        asyncio.create_task(resolve_story_vote(session.id))

    await timer_service.start_timer(
        session.id, "story_vote", timer_seconds, _on_story_vote_timeout
    )
    log_event(
        logger,
        logging.INFO,
        "story_vote.started",
        "Story vote phase started",
        session_id=str(session.id),
        options=len(stories),
    )
    return {"status": "active", "phase": {"type": "story_vote", "number": 0}}


async def submit_story_vote(
    db: AsyncSession, session: Session, player: Player, story_id: uuid.UUID
) -> dict:
    phase = await get_current_phase(db, session.id)
    if not phase or phase.phase_type != "story_vote":
        raise GameError(403, "wrong_phase", "Голосование за сюжет недоступно")
    if player.status != "alive":
        raise GameError(403, "player_dead", "Выбывшие игроки не могут голосовать")

    stories = await _votable_stories(db)
    valid_ids = {str(s.id) for s in stories}
    if str(story_id) not in valid_ids:
        raise GameError(404, "story_not_found", "Сюжет недоступен для голосования")

    already = await db.scalar(
        select(GameEvent.id).where(
            GameEvent.session_id == session.id,
            GameEvent.phase_id == phase.id,
            GameEvent.event_type == "story_vote",
            GameEvent.payload["player_id"].astext == str(player.id),
        )
    )
    if already is not None:
        raise GameError(409, "action_already_submitted", "Вы уже проголосовали")

    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id,
            event_type="story_vote",
            payload={"player_id": str(player.id), "story_id": str(story_id)},
        )
    )
    await db.commit()

    counts, voted = await _tally_story_votes(db, session.id, phase.id)
    alive_total = int(
        await db.scalar(
            select(func.count(Player.id)).where(
                Player.session_id == session.id, Player.status == "alive"
            )
        )
        or 0
    )
    await ws_manager.send_to_session(
        session.id,
        {
            "type": "story_vote_update",
            "payload": {
                "counts": counts,
                "voted": voted,
                "alive_total": alive_total,
            },
        },
    )
    if voted >= alive_total and alive_total > 0:
        await timer_service.cancel_timer(session.id, "story_vote")
        asyncio.create_task(resolve_story_vote(session.id))
    return {"ok": True}


async def resolve_story_vote(session_id: uuid.UUID) -> None:
    """Подводит итог голосования: большинство, при ничьей — случайный лидер.

    Без голосов — случайный сюжет из доступных. Затем закрывает фазу
    story_vote, фиксирует ``session.story_id`` и переходит к role_reveal.
    """
    from core.database import async_session_factory

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        phase = await get_current_phase(db, session_id)
        if phase is None or phase.phase_type != "story_vote":
            return  # уже разрешено

        stories = await _votable_stories(db)
        chosen_id: str | None = None
        if stories:
            counts, _ = await _tally_story_votes(db, session_id, phase.id)
            if counts:
                top = max(counts.values())
                leaders = [sid for sid, c in counts.items() if c == top]
                chosen_id = random.choice(leaders)
            else:
                chosen_id = random.choice([str(s.id) for s in stories])

        session.story_id = uuid.UUID(chosen_id) if chosen_id else None
        phase.ended_at = utc_now()
        await db.commit()

        await timer_service.cancel_timer(session_id, "story_vote")
        await ws_manager.send_to_session(
            session_id,
            {
                "type": "story_vote_result",
                "payload": {"story_id": chosen_id},
            },
        )
        log_event(
            logger,
            logging.INFO,
            "story_vote.resolved",
            "Story vote resolved",
            session_id=str(session_id),
            story_id=chosen_id,
        )
        await start_name_pick(db, session)


# ----------------------------------------------------------------------------
# Фаза name_pick: выбор имени из набора победившего сюжета (после story_vote).
# ----------------------------------------------------------------------------

NAME_PICK_DEFAULT_TIMER = 60


async def _name_pick_options(db: AsyncSession, session: Session) -> list[dict]:
    """Список кандидатных имён для фазы name_pick.

    Источник — собственный набор имён выбранного сюжета (``story_names``).
    Фолбэк (у сюжета нет своих имён / сюжет не выбран) — глобальный манифест
    озвучки (с гендером, как раньше на StorySelectionPage).
    """
    if session.story_id is not None:
        rows = (
            await db.scalars(
                select(StoryName)
                .where(StoryName.story_id == session.story_id)
                .order_by(StoryName.sort_order, StoryName.display_name)
            )
        ).all()
        if rows:
            return [
                {"display": n.display_name, "gender": None, "description": n.description}
                for n in rows
            ]
    return [
        {"display": n.display, "gender": n.gender, "description": None}
        for n in get_audio_manifest().names
    ]


async def start_name_pick(db: AsyncSession, session: Session) -> None:
    """Создаёт фазу ``name_pick`` и рассылает кандидатные имена.

    Запускается после резолва ``story_vote`` (или сразу, если голосовать не за
    что). Игроки выбирают имя из набора победившего сюжета. По истечении
    таймера / когда все выбрали — ``resolve_name_pick`` раздаёт роли.
    """
    options = await _name_pick_options(db, session)

    phase = GamePhase(
        id=uuid.uuid4(),
        session_id=session.id,
        phase_type="name_pick",
        phase_number=0,
        started_at=utc_now(),
        ended_at=None,
    )
    db.add(phase)
    if session.status != "active":
        session.status = "active"
    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id,
            event_type="name_pick_started",
            payload={"phase": {"type": "name_pick", "number": 0}},
        )
    )
    await db.commit()

    timer_seconds = int(
        (session.settings or {}).get("name_pick_timer_seconds")
        or NAME_PICK_DEFAULT_TIMER
    )
    rt = runtime_state.get(session.id)
    rt.timer_name = "name_pick"
    rt.timer_seconds = timer_seconds
    rt.timer_started_at = phase.started_at

    # См. start_story_vote: persist phase_changed для reconnect/recovery-safe
    # таймера (иначе recovery_loop затирает runtime-таймер в None).
    await _persist_phase_changed(
        db,
        session.id,
        phase.id,
        {
            "phase": {"type": "name_pick", "number": 0},
            "timer_name": "name_pick",
            "timer_seconds": timer_seconds,
            "timer_started_at": phase.started_at.isoformat(),
        },
    )

    await ws_manager.send_to_session(
        session.id,
        {
            "type": "phase_changed",
            "payload": {
                "phase": {"type": "name_pick", "number": 0},
                "timer_seconds": timer_seconds,
                "timer_started_at": phase.started_at.isoformat(),
                "names": options,
            },
        },
    )

    async def _on_name_pick_timeout():
        asyncio.create_task(resolve_name_pick(session.id))

    await timer_service.start_timer(
        session.id, "name_pick", timer_seconds, _on_name_pick_timeout
    )
    log_event(
        logger,
        logging.INFO,
        "name_pick.started",
        "Name pick phase started",
        session_id=str(session.id),
        options=len(options),
    )


async def submit_name_pick(
    db: AsyncSession, session: Session, player: Player, name: str
) -> dict:
    """Игрок выбирает имя из набора сюжета на фазе ``name_pick``."""
    phase = await get_current_phase(db, session.id)
    if not phase or phase.phase_type != "name_pick":
        raise GameError(403, "wrong_phase", "Выбор имени сейчас недоступен")
    if player.status != "alive":
        raise GameError(403, "player_dead", "Выбывшие игроки не выбирают имя")

    chosen = name.strip()
    allowed = await _allowed_player_names(db, session)
    if chosen not in allowed:
        raise GameError(404, "name_not_allowed", "Имя недоступно для этого сюжета")

    others = list(
        (
            await db.scalars(
                select(Player).where(
                    Player.session_id == session.id, Player.id != player.id
                )
            )
        ).all()
    )
    if any(p.name == chosen for p in others):
        raise GameError(409, "name_taken", "Это имя уже занято другим игроком")

    player.name = chosen
    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id,
            event_type="player_renamed",
            payload={"player_id": str(player.id), "name": chosen, "auto": False},
        )
    )
    await db.commit()

    await ws_manager.send_to_session(
        session.id,
        {
            "type": "player_renamed",
            "payload": {"player_id": str(player.id), "name": chosen, "auto": False},
        },
    )

    # Если все живые игроки выбрали имя из набора сюжета — не ждём таймер,
    # сразу закрываем фазу и раздаём роли (resolve_name_pick идемпотентен).
    alive_others = [p for p in others if p.status == "alive"]
    if all((p.name or "") in allowed for p in alive_others):
        await timer_service.cancel_timer(session.id, "name_pick")
        asyncio.create_task(resolve_name_pick(session.id))

    return {"ok": True}


async def resolve_name_pick(session_id: uuid.UUID) -> None:
    """Закрывает фазу ``name_pick`` и переходит к раздаче ролей."""
    from core.database import async_session_factory

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        phase = await get_current_phase(db, session_id)
        if phase is None or phase.phase_type != "name_pick":
            return  # уже разрешено

        phase.ended_at = utc_now()
        await db.commit()
        await timer_service.cancel_timer(session_id, "name_pick")
        log_event(
            logger,
            logging.INFO,
            "name_pick.resolved",
            "Name pick resolved",
            session_id=str(session_id),
        )
        await _run_role_reveal(db, session, enforce_audio_ready=False)


async def acknowledge_role(db: AsyncSession, session: Session, player: Player) -> dict:
    phase = await get_current_phase(db, session.id)
    if not phase or phase.phase_type != "role_reveal":
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")
    if player.status != "alive":
        raise GameError(403, "player_dead", "Выбывшие игроки не могут совершать действия")

    # Полагаемся на partial unique index (миграция 20260516_unique_role_ack):
    # параллельный второй запрос упадёт с IntegrityError, ловим его как 409.
    # SELECT-then-INSERT раньше был race-prone — между двумя запросами оба видели
    # пустой результат и оба успешно вставлялись.
    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id,
            event_type="role_acknowledged",
            payload={"player_id": str(player.id)},
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise GameError(409, "action_already_submitted", "Вы уже сделали выбор в этой фазе")

    alive_total = await db.scalar(
        select(func.count(Player.id)).where(Player.session_id == session.id, Player.status == "alive")
    )
    acked = await db.scalar(
        select(func.count(GameEvent.id)).where(
            GameEvent.session_id == session.id,
            GameEvent.phase_id == phase.id,
            GameEvent.event_type == "role_acknowledged",
        )
    )
    alive_total = int(alive_total or 0)
    acked = int(acked or 0)
    ack_subq = exists(
        select(1).where(
            GameEvent.session_id == session.id,
            GameEvent.phase_id == phase.id,
            GameEvent.event_type == "role_acknowledged",
            GameEvent.payload["player_id"].astext == cast(Player.id, String),
        )
    )
    pending_alive = await db.scalar(
        select(func.count(Player.id)).where(
            Player.session_id == session.id,
            Player.status == "alive",
            ~ack_subq,
        )
    )
    pending_alive = int(pending_alive or 0)
    await ws_manager.send_to_session(
        session.id,
        {
            "type": "role_acknowledged",
            "payload": {"player_id": str(player.id), "players_acknowledged": acked, "players_total": alive_total},
        },
    )
    if alive_total and pending_alive == 0:
        await ws_manager.send_to_session(session.id, {"type": "all_acknowledged", "payload": {}})
        # иначе сработает таймер role_reveal и второй раз вызовет transition_to_night → duplicate phase
        await timer_service.cancel_timer(session.id, "role_reveal")
        # Запускаем переход в ночь как фоновую задачу, чтобы HTTP-handler
        # acknowledge_role завершился моментально, а не держал соединение
        # до конца первой ночи (execute_night_sequence делает долгий await-loop).
        asyncio.create_task(_enter_first_night_or_story(session.id))
    log_event(
        logger,
        logging.INFO,
        "game.role_acknowledged",
        "Role acknowledgement persisted",
        session_id=str(session.id),
        player_id=str(player.id),
        acknowledged=acked,
        total=alive_total,
    )

    return {"acknowledged": True, "players_acknowledged": acked, "players_total": alive_total}


async def _enter_first_night_or_story(session_id: uuid.UUID) -> None:
    """Compatibility shim: запустить Story Engine, если включён флаг.

    Вызывается вместо прямого ``transition_to_night(session_id, 1)`` после
    role_reveal'а. Если ``session.story_id`` задан И
    ``session.settings.use_story_engine`` true — gameplay идёт через
    ``services.story_runtime``. Иначе — legacy ``transition_to_night``.

    В этапе 7 этот shim удаляется вместе с legacy.
    """
    from core.database import async_session_factory

    async with async_session_factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            return
        use_story_engine = bool(
            session.story_id and (session.settings or {}).get("use_story_engine")
        )

    if use_story_engine:
        # Локальный импорт: story_runtime может не существовать в legacy
        # тестовых окружениях (миграция Story Engine не применена).
        try:
            from services.story_runtime import start_story
        except ImportError:
            log_event(
                logger,
                logging.ERROR,
                "story_engine.import_failed",
                "use_story_engine=true но services.story_runtime не импортируется — fallback на legacy",
                session_id=str(session_id),
            )
            await transition_to_night(session_id, 1)
            return
        await start_story(session_id)
        return

    await transition_to_night(session_id, 1)


async def transition_to_night(session_id: uuid.UUID, phase_number: int):
    from core.database import async_session_factory

    rt = runtime_state.get(session_id)
    if rt.game_paused:
        return
    _begin_phase_transition(session_id)

    try:
        async with async_session_factory() as db:
            session = await db.get(Session, session_id)
            if not session or session.status != "active":
                return
            dup_night = await db.scalar(
                select(GamePhase.id).where(
                    GamePhase.session_id == session_id,
                    GamePhase.phase_number == phase_number,
                    GamePhase.phase_type == "night",
                )
            )
            if dup_night is not None:
                return
            current = await get_current_phase(db, session_id)

            # Свежий вход в ночь: сбрасываем блокировки и фиксируем
            # цели мафии/маньяка для новой ночи.
            rt = runtime_state.get(session_id)
            rt.blocked_tonight = set()
            rt.day_blocked_player = None
            rt.mafia_choice_target = None
            rt.mafia_choice_by = None
            rt.maniac_choice_target = None

            phase_payload = {
                "phase": {"type": "night", "number": phase_number},
                "sub_phase": None,
                "timer_seconds": None,
                "timer_started_at": None,
            }

            # Сначала создаём новую фазу и только потом закрываем старую, чтобы
            # /state никогда не оставался без актуальной активной фазы.
            phase = GamePhase(
                id=uuid.uuid4(),
                session_id=session_id,
                phase_type="night",
                phase_number=phase_number,
                started_at=utc_now(),
                ended_at=None,
            )
            db.add(phase)
            if current and current.ended_at is None:
                current.ended_at = phase.started_at
            await db.commit()
            try:
                await _persist_phase_changed(
                    db,
                    session_id,
                    phase.id,
                    {
                        "phase": {"type": "night", "number": phase_number},
                        "sub_phase": None,
                        "night_turn": None,
                        "timer_name": None,
                        "timer_seconds": None,
                        "timer_started_at": None,
                        "blocked_tonight": [],
                    },
                )
            except IntegrityError:
                await db.rollback()
                return

            rt.night_sequence_running = True
            try:
                # ── Pre-night narrator sequence ─────────────────────────────────
                if phase_number == 1:
                    await _play_phase_announcements(
                        session_id,
                        phase_payload,
                        game_started_steps(f"{session_id}:night:{phase_number}:game_started"),
                        db=db,
                        phase_id=phase.id,
                        persist=True,
                    )
                    if rt.game_paused:
                        return
                    await _play_phase_announcements(
                        session_id,
                        phase_payload,
                        all_acknowledged_steps(f"{session_id}:night:{phase_number}:all_acknowledged"),
                        db=db,
                        phase_id=phase.id,
                        persist=True,
                    )
                    if rt.game_paused:
                        return

                await _play_phase_announcements(
                    session_id,
                    phase_payload,
                    night_start_steps(f"{session_id}:night:{phase_number}:start", phase_number),
                    db=db,
                    phase_id=phase.id,
                    persist=True,
                )
                if rt.game_paused:
                    return

                paused = await execute_night_sequence(db, session, phase)
                if paused == "paused":
                    return
            finally:
                rt.night_sequence_running = False
            log_event(
                logger,
                logging.INFO,
                "phase.changed",
                "Transitioned to night phase",
                session_id=str(session_id),
                phase={"type": "night", "number": phase_number},
            )
    finally:
        _end_phase_transition(session_id)


async def execute_night_sequence(
    db: AsyncSession,
    session: Session,
    phase: GamePhase,
    resume_from: tuple[str, int] | None = None,
) -> str | None:
    """Ночная очередь. Возвращает \"paused\", если игра поставлена на паузу (resolve_night не вызывается).

    Очередь: lover -> mafia -> don -> sheriff -> maniac -> doctor.
    Роли с 0 в role_config пропускаются полностью.
    Если роль выбрана в сессии, но актёр мёртв/заблокирован — проигрывается пустой ход с тем же таймером.
    """
    settings = session.settings or {}
    turn_seconds = int(settings.get("night_action_timer_seconds") or 30)
    rt = runtime_state.get(session.id)

    players = (
        await db.scalars(
            select(Player)
            .options(selectinload(Player.role), selectinload(Player.user))
            .where(Player.session_id == session.id)
        )
    ).all()
    alive = [p for p in players if p.status == "alive"]
    # подтянуть роли одним запросом
    role_ids = {p.role_id for p in alive if p.role_id}
    roles = (await db.scalars(select(Role).where(Role.id.in_(role_ids)))).all() if role_ids else []
    role_by_id = {r.id: r for r in roles}

    def role_slug(p: Player) -> str | None:
        if not p.role_id:
            return None
        r = role_by_id.get(p.role_id)
        return r.slug if r else None

    async def _doctor_context(actor: Player) -> tuple[list[dict], dict | None]:
        prev_phase = await db.scalar(
            select(GamePhase).where(
                GamePhase.session_id == session.id,
                GamePhase.phase_type == "night",
                GamePhase.phase_number == phase.phase_number - 1,
            ).limit(1)
        )
        prev_heal_target_id: uuid.UUID | None = None
        if prev_phase is not None:
            prev_heal_target_id = await db.scalar(
                select(NightAction.target_player_id).where(
                    NightAction.phase_id == prev_phase.id,
                    NightAction.actor_player_id == actor.id,
                    NightAction.action_type == "heal",
                )
            )
        heal_restriction = None
        if prev_heal_target_id is not None:
            restricted_p = next((p for p in alive if p.id == prev_heal_target_id), None)
            if restricted_p:
                heal_restriction = {
                    "player_id": str(restricted_p.id),
                    "name": restricted_p.name,
                    "reason": "Нельзя лечить одного и того же два раунда подряд",
                }
        available_targets = [
            _player_target_dict(p)
            for p in alive
            if p.id != prev_heal_target_id
        ]
        return available_targets, heal_restriction

    async def _action_payload_for(turn_slug: str, actor: Player | None) -> tuple[dict | None, str | None]:
        if actor is None:
            return None, None
        if turn_slug == "lover":
            return {
                "action_type": "lover_visit",
                "available_targets": [
                    _player_target_dict(p)
                    for p in alive
                    if p.id != actor.id and p.id != rt.lover_last_target
                ],
            }, "lover_visit"
        if turn_slug == "don":
            def _not_mafia_target(pl: Player) -> bool:
                if pl.id == actor.id:
                    return False
                if not pl.role_id:
                    return True
                r = role_by_id.get(pl.role_id)
                return r is None or r.team != "mafia"

            return {
                "action_type": "don_check",
                "available_targets": [
                    _player_target_dict(p)
                    for p in alive
                    if _not_mafia_target(p)
                ],
            }, "don_check"
        if turn_slug == "sheriff":
            return {
                "action_type": "check",
                "available_targets": [
                    _player_target_dict(p)
                    for p in alive
                    if p.id != actor.id
                ],
            }, "check"
        if turn_slug == "doctor":
            targets, heal_restriction = await _doctor_context(actor)
            payload = {
                "action_type": "heal",
                "available_targets": targets,
            }
            if heal_restriction:
                payload["heal_restriction"] = heal_restriction
            return payload, "heal"
        if turn_slug == "maniac":
            return {
                "action_type": "maniac_kill",
                "available_targets": [
                    _player_target_dict(p)
                    for p in alive
                    if p.id != actor.id
                ],
            }, "maniac_kill"
        return None, None

    async def _run_turn(turn_slug: str, seconds_for_turn: int, *, resume_timer_only: bool = False) -> str | None:
        """Возвращает \"paused\" | \"aborted\" или None если ход завершён штатно."""

        if not _is_turn_enabled(session, turn_slug):
            return None

        mafia_actors: list[Player] = []
        actor: Player | None = None
        action_available = False
        action_type: str | None = None
        action_payload: dict | None = None

        if turn_slug == "mafia":
            already_kill = await db.scalar(
                select(NightAction.id).where(
                    NightAction.phase_id == phase.id,
                    NightAction.action_type == "kill",
                )
            )
            if already_kill is not None:
                return None

            mafia_actors = [p for p in alive if role_slug(p) == "mafia"]
            action_available = len([p for p in mafia_actors if p.id not in rt.blocked_tonight]) > 0
            action_type = "kill"
        else:
            solo_actors = [p for p in alive if role_slug(p) == turn_slug]
            actor = solo_actors[0] if solo_actors else None
            if actor is not None:
                already = await db.scalar(
                    select(NightAction.id).where(
                        NightAction.phase_id == phase.id,
                        NightAction.actor_player_id == actor.id,
                    )
                )
                if already is not None:
                    return None
                action_available = actor.id not in rt.blocked_tonight
                action_payload, action_type = await _action_payload_for(turn_slug, actor)

        has_don = _is_turn_enabled(session, "don")
        if not resume_timer_only:
            await _play_phase_announcements(
                session.id,
                {
                    "phase": {"type": "night", "number": phase.phase_number},
                    "sub_phase": None,
                    "night_turn": turn_slug,
                    "timer_name": None,
                    "timer_seconds": None,
                    "timer_started_at": None,
                },
                turn_intro_steps(turn_slug, f"{session.id}:night:{phase.phase_number}:{turn_slug}:intro", has_don=has_don),
                db=db,
                phase_id=phase.id,
                persist=True,
            )
            if rt.game_paused:
                return "paused"

        rt.night_turn = turn_slug
        rt.timer_name = f"night_{turn_slug}"
        rt.timer_seconds = seconds_for_turn
        rt.timer_started_at = utc_now()
        rt.night_action_event.clear()

        phase_payload = {
            "phase": {"type": "night", "number": phase.phase_number},
            "sub_phase": None,
            "night_turn": turn_slug,
            "timer_name": rt.timer_name,
            "timer_seconds": seconds_for_turn,
            "timer_started_at": rt.timer_started_at.isoformat(),
            "blocked_tonight": [str(x) for x in rt.blocked_tonight],
        }
        await _emit_phase_changed(
            session.id,
            phase_payload,
            db=db,
            phase_id=phase.id,
            persist=True,
        )

        if turn_slug == "mafia" and action_available:
            def _is_non_mafia(pl: Player) -> bool:
                if not pl.role_id:
                    return True
                r = role_by_id.get(pl.role_id)
                return r is None or r.team != "mafia"

            available_targets = [
                _player_target_dict(p)
                for p in alive
                if _is_non_mafia(p)
            ]
            for mafia_actor in mafia_actors:
                if mafia_actor.id in rt.blocked_tonight:
                    await ws_manager.send_to_user(
                        session.id,
                        mafia_actor.user_id,
                        {"type": "action_blocked", "payload": {"action_type": "kill", "reason": "lover_block"}},
                    )
                    continue
                await ws_manager.send_to_user(
                    session.id,
                    mafia_actor.user_id,
                    {
                        "type": "action_required",
                        "payload": {
                            "action_type": "kill",
                            "available_targets": available_targets,
                            "timer_seconds": seconds_for_turn,
                            "timer_started_at": rt.timer_started_at.isoformat(),
                        },
                    },
                )
        elif actor is not None and action_payload and action_available:
            action_payload = {
                **action_payload,
                "timer_seconds": seconds_for_turn,
                "timer_started_at": rt.timer_started_at.isoformat(),
            }
            await ws_manager.send_to_user(
                session.id,
                actor.user_id,
                {"type": "action_required", "payload": action_payload},
            )
        elif actor is not None and action_type and not action_available:
            await ws_manager.send_to_user(
                session.id,
                actor.user_id,
                {"type": "action_blocked", "payload": {"action_type": action_type, "reason": "lover_block"}},
            )

        async def _timeout():
            await ws_manager.send_to_session(
                session.id, {"type": "action_timeout", "payload": {"action_type": turn_slug}}
            )
            rt.night_action_event.set()

        await timer_service.start_timer(session.id, rt.timer_name, seconds_for_turn, _timeout)
        await rt.night_action_event.wait()
        await timer_service.cancel_timer(session.id, rt.timer_name)
        rt.night_action_event.clear()
        if rt.night_sequence_abort:
            return "aborted"
        if rt.game_paused:
            return "paused"

        if action_available and turn_slug in {"sheriff", "don"}:
            await _wait_or_pause(session.id, 5)
            if rt.game_paused:
                return "paused"

        await _play_phase_announcements(
            session.id,
            {
                "phase": {"type": "night", "number": phase.phase_number},
                "sub_phase": None,
                "night_turn": turn_slug,
                "timer_name": None,
                "timer_seconds": None,
                "timer_started_at": None,
            },
            turn_outro_steps(f"{turn_slug}", f"{session.id}:night:{phase.phase_number}:{turn_slug}:outro", has_don=has_don),
            db=db,
            phase_id=phase.id,
            persist=True,
        )
        if rt.game_paused:
            return "paused"

        return None

    order = ["lover", "mafia", "don", "sheriff", "maniac", "doctor"]
    start_idx = 0
    first_seconds: int | None = None
    if resume_from:
        try:
            start_idx = order.index(resume_from[0])
        except ValueError:
            start_idx = 0
        first_seconds = max(1, int(resume_from[1]))

    for i, turn_slug in enumerate(order[start_idx:], start=start_idx):
        if rt.night_sequence_abort:
            break
        if rt.game_paused:
            return "paused"
        sec = first_seconds if (first_seconds is not None and i == start_idx) else turn_seconds
        res = await _run_turn(turn_slug, sec, resume_timer_only=bool(first_seconds is not None and i == start_idx))
        if res == "paused":
            return "paused"
        if res == "aborted":
            break

    if rt.night_sequence_abort:
        rt.night_sequence_abort = False

    rt.night_turn = None
    rt.timer_name = None
    rt.timer_seconds = None
    rt.timer_started_at = None

    await resolve_night(db, session, phase)
    return None


def request_night_abort(session_id: uuid.UUID) -> None:
    """Кик во время ночи: прервать ожидание хода и дойти до resolve_night."""
    rt = runtime_state.get(session_id)
    rt.night_sequence_abort = True
    rt.night_action_event.set()


async def resolve_night(db: AsyncSession, session: Session, phase: GamePhase) -> None:
    """Подсчёт жертв ночи.

    Жертвы = (мафия_цель ∪ маньяк_цель) - доктор_цель.
    Если мафия/маньяк были заблокированы любовницей — их действий в БД быть
    не должно (роутер не принимает действия у заблокированных), но на всякий
    случай перепроверяем флаг was_blocked.
    """
    rt = runtime_state.get(session.id)
    _begin_phase_transition(session.id)
    try:

        mafia_action = await db.scalar(
        select(NightAction).where(NightAction.phase_id == phase.id, NightAction.action_type == "kill")
        )
        maniac_action = await db.scalar(
        select(NightAction).where(NightAction.phase_id == phase.id, NightAction.action_type == "maniac_kill")
        )
        doctor_action = await db.scalar(
        select(NightAction).where(NightAction.phase_id == phase.id, NightAction.action_type == "heal")
        )
        lover_action = await db.scalar(
        select(NightAction).where(NightAction.phase_id == phase.id, NightAction.action_type == "lover_visit")
        )

    # Соберём цели атак (учитываем только атаки от незаблокированных игроков).
        attack_target_ids: set[uuid.UUID] = set()
        if mafia_action and not mafia_action.was_blocked:
            attack_target_ids.add(mafia_action.target_player_id)
        if maniac_action and not maniac_action.was_blocked:
            attack_target_ids.add(maniac_action.target_player_id)

        healed_id: uuid.UUID | None = doctor_action.target_player_id if doctor_action else None
        saved_player: Player | None = await db.get(Player, healed_id) if healed_id else None

        lover_actor_id = lover_action.actor_player_id if lover_action else None
        lover_target_id = lover_action.target_player_id if lover_action else None

    # Если любовница увела игрока на ночь, прямое нападение по этой цели промахивается.
        if lover_target_id is not None and lover_target_id in attack_target_ids:
            attack_target_ids.discard(lover_target_id)
            if mafia_action and mafia_action.target_player_id == lover_target_id:
                mafia_action.was_blocked = True
            if maniac_action and maniac_action.target_player_id == lover_target_id:
                maniac_action.was_blocked = True

        direct_death_ids = set(attack_target_ids)
        if healed_id is not None and healed_id in direct_death_ids:
            if mafia_action and mafia_action.target_player_id == healed_id:
                mafia_action.was_blocked = True
            if maniac_action and maniac_action.target_player_id == healed_id:
                maniac_action.was_blocked = True
            direct_death_ids.discard(healed_id)

        collateral_death_ids: set[uuid.UUID] = set()
        if lover_actor_id is not None and lover_target_id is not None and lover_actor_id in direct_death_ids:
            collateral_death_ids.add(lover_target_id)
        if healed_id is not None and healed_id in collateral_death_ids:
            collateral_death_ids.discard(healed_id)

        final_death_ids = direct_death_ids | collateral_death_ids

        died_players: list[Player] = []
        for tid in final_death_ids:
            target_player = await db.get(Player, tid)
            if target_player and target_player.status == "alive":
                target_player.status = "dead"
                died_players.append(target_player)

    # Обновим "последняя цель лавера" и "заблокированный на день игрок".
        if lover_action:
            rt.lover_last_target = lover_action.target_player_id
            rt.day_blocked_player = lover_action.target_player_id
        else:
            rt.day_blocked_player = None

        blocked_player = await db.get(Player, rt.day_blocked_player) if rt.day_blocked_player else None
        died_payload = [
            {"player_id": str(p.id), "name": p.name} for p in died_players
        ]
        payload = {
        "died": died_payload if died_payload else None,
        "saved_player": (
            {"player_id": str(saved_player.id), "name": saved_player.name}
            if saved_player and healed_id is not None and healed_id not in final_death_ids
            else None
        ),
        "day_blocked_player": str(rt.day_blocked_player) if rt.day_blocked_player else None,
        "night_outcome": {
            "phase_number": phase.phase_number,
            "died_count": len(died_players),
            "saved": bool(saved_player and healed_id is not None and healed_id not in final_death_ids),
            "blocked_player_name": blocked_player.name if blocked_player else None,
        },
        }
        morning_steps_raw = night_result_steps(
        f"{session.id}:night_result:{phase.phase_number}",
        phase_number=phase.phase_number,
        died_names=[p.name for p in died_players],
        saved_name=(saved_player.name if saved_player and healed_id is not None and healed_id not in final_death_ids else None),
        blocked_name=(blocked_player.name if blocked_player else None),
        )
        # Резолв аудио: для "one_killed" подставляется имя жертвы.
        single_victim_name = died_players[0].name if len(died_players) == 1 else None
        morning_steps = resolve_steps(
            morning_steps_raw,
            target_player_name=single_victim_name,
            target_player_gender=_gender_for_name(single_victim_name),
        )
        first_morning = await _set_runtime_announcement(session.id, morning_steps[0]) if morning_steps else None
        db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id,
            event_type="night_result",
            payload={
                **payload,
                "announcement": first_morning,
                # Для восстановления runtime_state после рестарта.
                "lover_last_target": str(rt.lover_last_target) if rt.lover_last_target else None,
                "day_blocked_player": str(rt.day_blocked_player) if rt.day_blocked_player else None,
            },
        )
        )
        for dp in died_players:
            db.add(
            GameEvent(
                id=uuid.uuid4(),
                session_id=session.id,
                phase_id=phase.id,
                event_type="player_eliminated",
                payload={"player_id": str(dp.id), "name": dp.name, "cause": "night"},
            )
        )
        await db.commit()

        await ws_manager.send_to_session(
        session.id,
        {"type": "night_result", "payload": {**payload, "announcement": first_morning}},
        )
        if died_players:
            await asyncio.gather(*(
                ws_manager.send_to_session(
                    session.id,
                    {
                        "type": "player_eliminated",
                        "payload": {"player_id": str(dp.id), "name": dp.name, "cause": "night"},
                    },
                )
                for dp in died_players
            ))

        if len(morning_steps) > 1:
            for announcement in morning_steps[1:]:
                stamped = await _set_runtime_announcement(session.id, announcement)
                await ws_manager.send_to_session(
                session.id,
                {"type": "night_result", "payload": {**payload, "announcement": stamped}},
            )
                await _wait_or_pause(session.id, _wait_seconds_for(announcement))
                if rt.game_paused:
                    return
        else:
            await _wait_or_pause(session.id, _wait_seconds_for(morning_steps[0]) if morning_steps else 0)

        winner = await check_win_condition(db, session.id)
        if winner:
            await finish_game(db, session, winner, before_voting=True)
            return

        # переход в день
        await transition_to_day(session.id, phase.phase_number)
    finally:
        _end_phase_transition(session.id)


async def transition_to_day(session_id: uuid.UUID, phase_number: int):
    from core.database import async_session_factory

    rt = runtime_state.get(session_id)
    if rt.game_paused:
        return
    _begin_phase_transition(session_id)
    try:
        async with async_session_factory() as db:
            session = await db.get(Session, session_id)
            if not session or session.status != "active":
                return
            dup_day = await db.scalar(
                select(GamePhase.id).where(
                    GamePhase.session_id == session_id,
                    GamePhase.phase_number == phase_number,
                    GamePhase.phase_type == "day",
                )
            )
            if dup_day is not None:
                return
            current = await get_current_phase(db, session_id)

            phase = GamePhase(
                id=uuid.uuid4(),
                session_id=session_id,
                phase_type="day",
                phase_number=phase_number,
                started_at=utc_now(),
                ended_at=None,
            )
            db.add(phase)
            if current and current.ended_at is None:
                current.ended_at = phase.started_at

            await db.commit()

            await _play_phase_announcements(
                session_id,
                {
                    "phase": {"type": "day", "number": phase_number},
                    "sub_phase": "discussion",
                    "timer_seconds": None,
                    "timer_started_at": None,
                },
                day_discussion_steps(f"{session_id}:day:{phase_number}:discussion_intro"),
                db=db,
                phase_id=phase.id,
                persist=True,
            )
            if rt.game_paused:
                return

            settings = session.settings or {}
            discussion_seconds = int(settings.get("discussion_timer_seconds") or 120)
            rt = runtime_state.get(session_id)
            rt.day_sub_phase = "discussion"
            rt.vote_round = 1
            rt.voting_candidate_ids = None
            rt.timer_name = "discussion"
            rt.timer_seconds = discussion_seconds
            rt.timer_started_at = utc_now()
            try:
                await _emit_phase_changed(
                    session_id,
                    {
                        "phase": {"type": "day", "number": phase_number},
                        "sub_phase": "discussion",
                        "night_turn": None,
                        "timer_name": "discussion",
                        "timer_seconds": discussion_seconds,
                        "timer_started_at": rt.timer_started_at.isoformat(),
                        "vote_round": 1,
                    },
                    db=db,
                    phase_id=phase.id,
                    persist=True,
                )
            except IntegrityError:
                await db.rollback()
                return

            async def _to_voting():
                await transition_to_voting(session_id)

            await timer_service.start_timer(session_id, "discussion", discussion_seconds, _to_voting)
            log_event(
                logger,
                logging.INFO,
                "phase.changed",
                "Transitioned to day discussion",
                session_id=str(session_id),
                phase={"type": "day", "number": phase_number},
                sub_phase="discussion",
            )
    finally:
        _end_phase_transition(session_id)


async def transition_to_voting(
    session_id: uuid.UUID,
    *,
    candidate_ids: list[uuid.UUID] | None = None,
    round_number: int = 1,
    intro_steps: list[dict] | None = None,
):
    from core.database import async_session_factory

    rt = runtime_state.get(session_id)
    if rt.game_paused:
        return
    _begin_phase_transition(session_id)
    try:
        async with async_session_factory() as db:
            session = await db.get(Session, session_id)
            if not session or session.status != "active":
                return
            phase = await get_current_phase(db, session_id)
            if not phase or phase.phase_type != "day":
                return

            settings = session.settings or {}
            voting_seconds = int(settings.get("voting_timer_seconds") or 60)
            rt = runtime_state.get(session_id)
            rt.day_sub_phase = "voting"
            rt.vote_round = round_number
            rt.voting_candidate_ids = candidate_ids
            rt.timer_name = "voting"
            rt.timer_seconds = voting_seconds
            rt.timer_started_at = None

            if intro_steps:
                await _play_phase_announcements(
                    session_id,
                    {
                        "phase": {"type": "day", "number": phase.phase_number},
                        "sub_phase": "voting",
                        "timer_seconds": None,
                        "timer_started_at": None,
                    },
                    intro_steps,
                    db=db,
                    phase_id=phase.id,
                    persist=True,
                )
                if rt.game_paused:
                    return
            elif round_number == 1:
                await _play_phase_announcements(
                    session_id,
                    {
                        "phase": {"type": "day", "number": phase.phase_number},
                        "sub_phase": "voting",
                        "timer_seconds": None,
                        "timer_started_at": None,
                    },
                    day_voting_steps(f"{session_id}:day:{phase.phase_number}:voting_intro"),
                    db=db,
                    phase_id=phase.id,
                    persist=True,
                )
                if rt.game_paused:
                    return

            rt.timer_started_at = utc_now()
            await _persist_phase_changed(
                db,
                session_id,
                phase.id,
                {
                    "phase": {"type": "day", "number": phase.phase_number},
                    "sub_phase": "voting",
                    "night_turn": None,
                    "timer_name": "voting",
                    "timer_seconds": voting_seconds,
                    "timer_started_at": rt.timer_started_at.isoformat(),
                    "vote_round": round_number,
                    "candidate_ids": [str(cid) for cid in candidate_ids] if candidate_ids else None,
                },
            )

            # Рассылаем phase_changed каждому игроку персонально, включая available_targets
            # (список живых, кроме себя и заблокированного), чтобы фронт мог отрисовать голосование
            # без дополнительного GET /state.
            players = (
                await db.scalars(
                    select(Player)
                    .options(selectinload(Player.user))
                    .where(Player.session_id == session_id)
                )
            ).all()
            alive = [p for p in players if p.status == "alive"]
            alive_candidates = [p for p in alive if candidate_ids is None or p.id in candidate_ids]
            timer_started_iso = rt.timer_started_at.isoformat()

            async def _send_voting_phase(p):
                is_alive = p.status == "alive"
                is_blocked = rt.day_blocked_player is not None and p.id == rt.day_blocked_player
                targets = (
                    [
                        _player_target_dict(t)
                        for t in alive_candidates
                        if t.id != p.id
                    ]
                    if is_alive and not is_blocked
                    else []
                )
                await ws_manager.send_to_user(
                    session_id,
                    p.user_id,
                    {
                        "type": "phase_changed",
                        "payload": {
                            "phase": {"type": "day", "number": phase.phase_number},
                            "sub_phase": "voting",
                            "timer_seconds": voting_seconds,
                            "timer_started_at": timer_started_iso,
                            "vote_round": round_number,
                            "awaiting_action": is_alive and not is_blocked,
                            "available_targets": targets,
                        },
                    },
                )

            await asyncio.gather(*(_send_voting_phase(p) for p in players))

            async def _resolve():
                await resolve_votes(session_id)

            await timer_service.start_timer(session_id, "voting", voting_seconds, _resolve)
            log_event(
                logger,
                logging.INFO,
                "phase.changed",
                "Transitioned to day voting",
                session_id=str(session_id),
                phase={"type": "day", "number": phase.phase_number},
                sub_phase="voting",
                vote_round=round_number,
            )
    finally:
        _end_phase_transition(session_id)


async def resolve_votes(session_id: uuid.UUID):
    from core.database import async_session_factory

    rt_check = runtime_state.get(session_id)
    if rt_check.game_paused:
        return
    _begin_phase_transition(session_id)
    try:
        async with async_session_factory() as db:
            session = await db.get(Session, session_id)
            if not session or session.status != "active":
                return
            phase = await get_current_phase(db, session_id)
            if not phase or phase.phase_type != "day":
                return

            rt = runtime_state.get(session_id)

            votes = (await db.scalars(select(DayVote).where(DayVote.phase_id == phase.id))).all()
            counts: dict[uuid.UUID, int] = {}
            for v in votes:
                if v.target_player_id is None:
                    continue
                counts[v.target_player_id] = counts.get(v.target_player_id, 0) + 1

            eliminated_id: uuid.UUID | None = None
            tied_ids: list[uuid.UUID] = []
            if counts:
                sorted_items = sorted(counts.items(), key=lambda x: x[1], reverse=True)
                top_votes = sorted_items[0][1]
                tied_ids = [player_id for player_id, votes_count in sorted_items if votes_count == top_votes]
                if len(tied_ids) == 1:
                    eliminated_id = sorted_items[0][0]
                elif rt.vote_round >= 2:
                    eliminated_id = random.choice(tied_ids)

            all_votes = [
                {
                    "voter_player_id": str(v.voter_player_id),
                    "target_player_id": str(v.target_player_id) if v.target_player_id else None,
                }
                for v in votes
            ]
            if tied_ids and eliminated_id is None and rt.vote_round == 1:
                tie_steps_raw = vote_tie_steps(f"{session_id}:day:{phase.phase_number}:vote_tie")
                tie_steps = resolve_steps(tie_steps_raw)
                tie_announcement = await _set_runtime_announcement(session_id, tie_steps[0])
                db.add(
                    GameEvent(
                        id=uuid.uuid4(),
                        session_id=session_id,
                        phase_id=phase.id,
                        event_type="vote_result",
                        payload={
                            "eliminated": None,
                            "votes": all_votes,
                            "tie": True,
                            "candidate_ids": [str(tid) for tid in tied_ids],
                            "announcement": tie_announcement,
                        },
                    )
                )
                await db.commit()
                await ws_manager.send_to_session(
                    session_id,
                    {
                        "type": "vote_result",
                        "payload": {
                            "eliminated": None,
                            "votes": all_votes,
                            "tie": True,
                            "candidate_ids": [str(tid) for tid in tied_ids],
                            "announcement": tie_announcement,
                        },
                    },
                )
                await _wait_or_pause(session_id, _wait_seconds_for(tie_steps[0]))
                await db.execute(delete(DayVote).where(DayVote.phase_id == phase.id))
                await db.commit()
                await transition_to_voting(
                    session_id,
                    candidate_ids=tied_ids,
                    round_number=2,
                )
                log_event(
                    logger,
                    logging.WARNING,
                    "game.vote_tie",
                    "Vote ended with tie, revote scheduled",
                    session_id=str(session_id),
                    candidate_ids=[str(item) for item in tied_ids],
                )
                return

            eliminated_player = await db.get(Player, eliminated_id) if eliminated_id else None
            if eliminated_player and eliminated_player.status == "alive":
                eliminated_player.status = "dead"

            winner = await check_win_condition(db, session_id) if eliminated_player else None
            vote_steps_raw = [] if winner else vote_result_steps(
                f"{session_id}:day:{phase.phase_number}:vote_result:{rt.vote_round}",
                eliminated_name=(eliminated_player.name if eliminated_player else None),
                random_elimination=bool(rt.vote_round >= 2 and len(tied_ids) > 1 and eliminated_player),
                unanimous_revote=bool(rt.vote_round >= 2 and len(tied_ids) <= 1 and eliminated_player),
            )
            elim_name = eliminated_player.name if eliminated_player else None
            vote_steps = resolve_steps(
                vote_steps_raw,
                target_player_name=elim_name,
                target_player_gender=_gender_for_name(elim_name),
            )
            vote_announcement = await _set_runtime_announcement(session_id, vote_steps[0]) if vote_steps else None
            db.add(
                GameEvent(
                    id=uuid.uuid4(),
                    session_id=session_id,
                    phase_id=phase.id,
                    event_type="vote_result",
                    payload={
                        "eliminated": str(eliminated_id) if eliminated_id else None,
                        "votes": all_votes,
                        "vote_round": rt.vote_round,
                        "announcement": vote_announcement,
                    },
                )
            )
            if eliminated_player and eliminated_player.status == "dead":
                db.add(
                    GameEvent(
                        id=uuid.uuid4(),
                        session_id=session_id,
                        phase_id=phase.id,
                        event_type="player_eliminated",
                        payload={"player_id": str(eliminated_player.id), "name": eliminated_player.name, "cause": "vote"},
                    )
                )
            await db.commit()

            await ws_manager.send_to_session(
                session_id,
                {
                    "type": "vote_result",
                    "payload": {
                        "eliminated": (
                            {"player_id": str(eliminated_player.id), "name": eliminated_player.name}
                            if eliminated_player and eliminated_id
                            else None
                        ),
                        "votes": all_votes,
                        "vote_round": rt.vote_round,
                        "announcement": vote_announcement,
                    },
                },
            )
            if eliminated_player and eliminated_id:
                await ws_manager.send_to_session(
                    session_id,
                    {
                        "type": "player_eliminated",
                        "payload": {"player_id": str(eliminated_player.id), "name": eliminated_player.name, "cause": "vote"},
                    },
                )

            if winner:
                await finish_game(
                    db,
                    session,
                    winner,
                    eliminated_name=(eliminated_player.name if eliminated_player else None),
                )
                return
            log_event(
                logger,
                logging.INFO,
                "vote.resolved",
                "Votes resolved",
                session_id=str(session_id),
                eliminated_player_id=str(eliminated_id) if eliminated_id else None,
                vote_round=rt.vote_round,
            )

            if vote_steps:
                await _wait_or_pause(session_id, _wait_seconds_for(vote_steps[0]))

            await transition_to_night(session_id, phase.phase_number + 1)
    finally:
        _end_phase_transition(session_id)


async def apply_host_kick(db: AsyncSession, session: Session, kicked: Player) -> None:
    """Кик хостом во время активной игры: игрок выбывает, ночь может прерваться и перейти к resolve."""
    kicked.status = "dead"
    phase = await get_current_phase(db, session.id)
    rt = runtime_state.get(session.id)

    if phase and phase.phase_type == "day" and rt.day_sub_phase == "voting":
        await db.execute(delete(DayVote).where(DayVote.phase_id == phase.id, DayVote.voter_player_id == kicked.id))

    if phase and phase.phase_type == "night":
        if rt.mafia_choice_by == kicked.id:
            rt.mafia_choice_target = None
            rt.mafia_choice_by = None

    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id if phase else None,
            event_type="player_kicked",
            payload={"player_id": str(kicked.id), "name": kicked.name},
        )
    )
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "session.player_kicked",
        "Host kick applied to runtime session",
        session_id=str(session.id),
        player_id=str(kicked.id),
    )

    if phase and phase.phase_type == "night":
        request_night_abort(session.id)
        await timer_service.cancel_all(session.id)

    winner = await check_win_condition(db, session.id)
    if winner:
        s2 = await db.get(Session, session.id)
        if s2:
            await finish_game(db, s2, winner)
        return

    if phase and phase.phase_type == "role_reveal":
        ack_subq = exists(
            select(1).where(
                GameEvent.session_id == session.id,
                GameEvent.phase_id == phase.id,
                GameEvent.event_type == "role_acknowledged",
                GameEvent.payload["player_id"].astext == cast(Player.id, String),
            )
        )
        pending_alive = await db.scalar(
            select(func.count(Player.id)).where(
                Player.session_id == session.id,
                Player.status == "alive",
                ~ack_subq,
            )
        )
        alive_cnt = await db.scalar(
            select(func.count(Player.id)).where(Player.session_id == session.id, Player.status == "alive")
        )
        if int(alive_cnt or 0) > 0 and int(pending_alive or 0) == 0:
            await timer_service.cancel_timer(session.id, "role_reveal")
            await transition_to_night(session.id, 1)
        return

    if phase and phase.phase_type == "day" and rt.day_sub_phase == "voting":
        votes_cast = await db.scalar(select(func.count(DayVote.id)).where(DayVote.phase_id == phase.id))
        eligible_q = select(func.count(Player.id)).where(Player.session_id == session.id, Player.status == "alive")
        if rt.day_blocked_player is not None:
            eligible_q = eligible_q.where(Player.id != rt.day_blocked_player)
        alive_cnt = await db.scalar(eligible_q)
        if int(votes_cast or 0) >= int(alive_cnt or 0) and int(alive_cnt or 0) > 0:
            await timer_service.cancel_timer(session.id, "voting")
            await resolve_votes(session.id)


async def finish_game(
    db: AsyncSession,
    session: Session,
    winner: str,
    *,
    eliminated_name: str | None = None,
    before_voting: bool = False,
) -> None:
    session.status = "finished"
    session.ended_at = utc_now()
    cur = dict(session.settings or {})
    cur.pop("game_pause", None)
    session.settings = cur
    phase = await get_current_phase(db, session.id)
    if phase and phase.ended_at is None:
        phase.ended_at = utc_now()

    players = (
        await db.scalars(
            select(Player)
            .options(selectinload(Player.role), selectinload(Player.user))
            .where(Player.session_id == session.id)
        )
    ).all()
    role_ids = {p.role_id for p in players if p.role_id}
    roles = (await db.scalars(select(Role).where(Role.id.in_(role_ids)))).all() if role_ids else []
    role_by_id = {r.id: r for r in roles}
    payload_players = [
        {
            "id": str(p.id),
            "name": p.name,
            "username": p.user.display_name if p.user else None,
            "role": {"name": role_by_id[p.role_id].name, "team": role_by_id[p.role_id].team} if p.role_id else None,
            "status": p.status,
        }
        for p in players
    ]
    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session.id,
            phase_id=phase.id if phase else None,
            event_type="game_finished",
            payload={"winner": winner, "players": payload_players},
        )
    )
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "game.finished",
        "Game finished",
        session_id=str(session.id),
        winner=winner,
    )

    finale_steps = game_finished_steps(
        f"{session.id}:finished:{winner}:{session.ended_at.isoformat() if session.ended_at else 'end'}",
        winner=winner,
        eliminated_name=eliminated_name,
        before_voting=before_voting,
    )
    finale_resolved = resolve_steps(
        finale_steps,
        target_player_name=eliminated_name,
        target_player_gender=_gender_for_name(eliminated_name),
    )
    finale_announcement = _stamp_started_at(finale_resolved[0]) if finale_resolved else None
    await ws_manager.send_to_session(
        session.id,
        {
            "type": "game_finished",
            "payload": {
                "winner": winner,
                "players": payload_players,
                "announcement": finale_announcement,
            },
        },
    )
    await timer_service.cancel_all(session.id)
    runtime_state.clear(session.id)
