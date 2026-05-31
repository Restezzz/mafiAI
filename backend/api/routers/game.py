"""Роуты игрового цикла (start/ночь/день/state).

Содержит REST-эндпоинты, которые меняют состояние игры.
WebSocket используется только для push-уведомлений.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.deps import get_current_user, get_db, get_player_or_404, get_session_or_404, require_host
from core.exceptions import GameError
from core.logging import log_event, set_log_context
from core.utils import session_is_paused
from models.day_vote import DayVote
from models.game_event import GameEvent
from models.game_phase import GamePhase
from models.night_action import NightAction
from models.player import Player
from models.role import Role
from models.session import Session
from models.session_story_state import SessionStoryState
from models.story import StoryRoleOverride
from schemas.game import (
    NamePickRequest,
    NightActionRequest,
    StoryVoteRequest,
    VoteRequest,
)
from services.game_engine import (
    _name_pick_options,
    _player_target_dict,
    acknowledge_role,
    get_current_phase,
    resolve_votes,
    start_game,
    start_story_vote,
    submit_name_pick,
    submit_story_vote,
    transition_to_voting,
)
from services.audio_preload import clear_audio_preload
from services.recovery_service import recover_missing_phase
from services.runtime_state import runtime_state
from services.timer_service import timer_service
from services.ws_manager import ws_manager
from services.state_service import get_last_known_phase, restore_runtime_like_fields


router = APIRouter()
logger = logging.getLogger(__name__)


def _ensure_announcement_started_at(announcement, started_at):
    """Гарантирует, что в announcement-payload есть `started_at` (ISO8601).

    Нужно для синхронизации typewriter/прогресс-бара между клиентами и при reload.
    """
    if not isinstance(announcement, dict):
        return announcement
    if announcement.get("started_at"):
        return announcement
    if started_at is None:
        return announcement
    return {**announcement, "started_at": started_at.isoformat()}


@router.post("/{session_id}/start")
async def start(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    require_host(session, current_user.id)
    set_log_context(session_id=str(session_id), user_id=str(current_user.id))

    # Фича 3: при новом сюжетном движке сначала голосование за сюжет
    # (story_vote), сюжет выбирается голосованием, а не в настройках.
    if bool((session.settings or {}).get("use_story_engine")):
        result = await start_story_vote(db, session)
        log_event(logger, logging.INFO, "game.started", "Story vote / game started", session_id=str(session_id), user_id=str(current_user.id))
        return result

    await start_game(db, session)
    log_event(logger, logging.INFO, "game.started", "Game started", session_id=str(session_id), user_id=str(current_user.id))
    return {"status": "active", "phase": {"type": "role_reveal", "number": 0}}


@router.post("/{session_id}/story-vote")
async def story_vote(
    session_id: uuid.UUID,
    body: StoryVoteRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    if session_is_paused(session.settings):
        raise GameError(403, "game_paused", "Игра на паузе")
    if session.status != "active":
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")
    player = await get_player_or_404(db, session_id, current_user.id)
    return await submit_story_vote(db, session, player, body.story_id)


@router.post("/{session_id}/name-pick")
async def name_pick(
    session_id: uuid.UUID,
    body: NamePickRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    if session_is_paused(session.settings):
        raise GameError(403, "game_paused", "Игра на паузе")
    if session.status != "active":
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")
    player = await get_player_or_404(db, session_id, current_user.id)
    return await submit_name_pick(db, session, player, body.name)


@router.post("/{session_id}/acknowledge-role")
async def ack_role(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    if session_is_paused(session.settings):
        raise GameError(403, "game_paused", "Игра на паузе")
    if session.status != "active":
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")

    player = await get_player_or_404(db, session_id, current_user.id)

    result = await acknowledge_role(db, session, player)
    log_event(
        logger,
        logging.INFO,
        "game.role_acknowledged",
        "Player acknowledged role",
        session_id=str(session_id),
        user_id=str(current_user.id),
        player_id=str(player.id),
    )
    return result


@router.post("/{session_id}/night-action")
async def night_action(
    session_id: uuid.UUID,
    payload: NightActionRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    if session_is_paused(session.settings):
        raise GameError(403, "game_paused", "Игра на паузе")

    player = await get_player_or_404(db, session_id, current_user.id)
    if player.status != "alive":
        raise GameError(403, "player_dead", "Выбывшие игроки не могут совершать действия")

    phase = await get_current_phase(db, session_id)
    if not phase or phase.phase_type != "night":
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")

    # #18: Pydantic валидирует UUID на этапе парсинга — невалидный target_player_id
    # уйдёт 400 validation_error через RequestValidationError handler.
    target_uuid = payload.target_player_id

    target = await db.get(Player, target_uuid)
    if not target or target.session_id != session_id:
        raise GameError(400, "invalid_target", "Невалидная цель")
    if target.status != "alive":
        raise GameError(400, "invalid_target", "Этот игрок уже выбыл")

    role = await db.get(Role, player.role_id) if player.role_id else None
    action_type = (role.abilities or {}).get("night_action") if role else None
    if not action_type:
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")

    rt = runtime_state.get(session_id)

    # Игрок, заблокированный любовницей, не может совершать ночные действия.
    if player.id in rt.blocked_tonight:
        raise GameError(403, "blocked_by_lover", "Вы заблокированы этой ночью")

    # ---- ограничения по типу действия
    # "kill" / "check" / "maniac_kill" / "lover_visit" / "don_check" — нельзя выбирать себя
    if action_type in ("kill", "check", "maniac_kill", "lover_visit", "don_check") and target.id == player.id:
        raise GameError(400, "invalid_target", "Нельзя выбрать себя")

    # "kill": нельзя атаковать мафию (и дона)
    if action_type == "kill":
        target_role = await db.get(Role, target.role_id) if target.role_id else None
        if target_role and target_role.team == "mafia":
            raise GameError(400, "invalid_target", "Нельзя атаковать мафию")

    # "don_check": нельзя проверять мафию/дона
    if action_type == "don_check":
        target_role = await db.get(Role, target.role_id) if target.role_id else None
        if target_role and target_role.team == "mafia":
            raise GameError(400, "invalid_target", "Нельзя проверять мафию")

    # "lover_visit": нельзя повторять цель две ночи подряд
    if action_type == "lover_visit":
        if rt.lover_last_target is not None and rt.lover_last_target == target.id:
            raise GameError(400, "invalid_target", "Нельзя посещать одного и того же игрока две ночи подряд")

    already = await db.scalar(
        select(NightAction.id).where(NightAction.phase_id == phase.id, NightAction.actor_player_id == player.id)
    )
    if already:
        raise GameError(409, "action_already_submitted", "Вы уже сделали выбор в этой фазе")

    # Доктор: нельзя лечить одного и того же игрока 2 ночи подряд.
    # Доктор: себя можно лечить только 1 раз за игру.
    if action_type == "heal":
        # предыдущая ночная фаза этой сессии
        prev_phase = await db.scalar(
            select(GamePhase)
            .where(
                GamePhase.session_id == session_id,
                GamePhase.phase_type == "night",
                GamePhase.phase_number == phase.phase_number - 1,
            )
            .limit(1)
        )
        if prev_phase is not None:
            prev_heal_target = await db.scalar(
                select(NightAction.target_player_id).where(
                    NightAction.phase_id == prev_phase.id,
                    NightAction.actor_player_id == player.id,
                    NightAction.action_type == "heal",
                )
            )
            if prev_heal_target is not None and prev_heal_target == target.id:
                raise GameError(400, "invalid_target", "Нельзя лечить одного и того же игрока два раунда подряд")

        if target.id == player.id:
            self_heal_used = await db.scalar(
                select(NightAction.id)
                .join(GamePhase, NightAction.phase_id == GamePhase.id)
                .where(
                    GamePhase.session_id == session_id,
                    NightAction.actor_player_id == player.id,
                    NightAction.action_type == "heal",
                    NightAction.target_player_id == player.id,
                )
                .limit(1)
            )
            if self_heal_used is not None:
                raise GameError(400, "invalid_target", "Себя доктор может вылечить только один раз за игру")

    # мафия: первый выбор фиксирует общий
    if action_type == "kill":
        if rt.mafia_choice_target is not None:
            # кто-то уже выбрал
            raise GameError(409, "action_already_submitted", "Выбор мафии уже сделан")
        rt.mafia_choice_target = target.id
        rt.mafia_choice_by = player.id

    # маньяк: сохраняем цель в runtime для резолвера
    if action_type == "maniac_kill":
        rt.maniac_choice_target = target.id

    # любовница: блокируем на ночь себя и цель
    if action_type == "lover_visit":
        rt.blocked_tonight.add(player.id)
        rt.blocked_tonight.add(target.id)

    na = NightAction(
        id=uuid.uuid4(),
        phase_id=phase.id,
        actor_player_id=player.id,
        target_player_id=target.id,
        action_type=action_type,
        was_blocked=False,
    )
    db.add(na)
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "night.action_submitted",
        "Night action submitted",
        session_id=str(session_id),
        user_id=str(current_user.id),
        player_id=str(player.id),
        action_type=action_type,
        target_player_id=str(target.id),
    )

    # WS подтверждение
    await ws_manager.send_to_user(
        session_id,
        current_user.id,
        {"type": "action_confirmed", "payload": {"action_type": action_type}},
    )
    resp = {"action_type": action_type, "target_player_id": str(target.id), "confirmed": True}

    if action_type == "check":
        target_role = await db.get(Role, target.role_id) if target.role_id else None
        team = target_role.team if target_role else "city"
        resp["check_result"] = {"team": team}
        await ws_manager.send_to_user(
            session_id,
            current_user.id,
            {"type": "check_result", "payload": {"target_player_id": str(target.id), "team": team}},
        )

    if action_type == "don_check":
        target_role = await db.get(Role, target.role_id) if target.role_id else None
        is_sheriff = bool(target_role and target_role.team == "city" and target_role.slug == "sheriff")
        resp["check_result"] = {"is_sheriff": is_sheriff}
        await ws_manager.send_to_user(
            session_id,
            current_user.id,
            {
                "type": "check_result",
                "payload": {"target_player_id": str(target.id), "is_sheriff": is_sheriff},
            },
        )

    return resp


@router.post("/{session_id}/vote")
async def vote(
    session_id: uuid.UUID,
    payload: VoteRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    if session_is_paused(session.settings):
        raise GameError(403, "game_paused", "Игра на паузе")
    player = await get_player_or_404(db, session_id, current_user.id)
    if player.status != "alive":
        raise GameError(403, "player_dead", "Выбывшие игроки не могут совершать действия")

    phase = await get_current_phase(db, session_id)
    if not phase or phase.phase_type != "day":
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")
    rt = runtime_state.get(session_id)
    if rt.day_sub_phase != "voting":
        raise GameError(403, "wrong_phase", "Действие недоступно в текущей фазе")

    # Игрок, которого посещала любовница прошлой ночью, не может голосовать.
    if rt.day_blocked_player is not None and rt.day_blocked_player == player.id:
        raise GameError(403, "blocked_by_lover", "Вы заблокированы после визита любовницы")

    already = await db.scalar(
        select(DayVote.id).where(DayVote.phase_id == phase.id, DayVote.voter_player_id == player.id)
    )
    if already:
        raise GameError(409, "action_already_submitted", "Вы уже сделали выбор в этой фазе")

    # #18: Pydantic валидирует UUID, None означает «воздержался».
    target_uuid = payload.target_player_id
    if target_uuid is not None:
        if target_uuid == player.id:
            raise GameError(400, "invalid_target", "Нельзя голосовать за себя")
        target = await db.get(Player, target_uuid)
        if not target or target.session_id != session_id or target.status != "alive":
            raise GameError(400, "invalid_target", "Невалидная цель")

    dv = DayVote(id=uuid.uuid4(), phase_id=phase.id, voter_player_id=player.id, target_player_id=target_uuid)
    db.add(dv)
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "vote.submitted",
        "Vote submitted",
        session_id=str(session_id),
        user_id=str(current_user.id),
        player_id=str(player.id),
        target_player_id=str(target_uuid) if target_uuid else None,
    )

    # ws vote_update
    votes_cast = await db.scalar(select(func.count(DayVote.id)).where(DayVote.phase_id == phase.id))
    # Exclude lover-blocked player from total so "all voted" check is correct.
    votes_total_q = select(func.count(Player.id)).where(Player.session_id == session_id, Player.status == "alive")
    if rt.day_blocked_player is not None:
        votes_total_q = votes_total_q.where(Player.id != rt.day_blocked_player)
    votes_total = await db.scalar(votes_total_q)
    await ws_manager.send_to_session(session_id, {"type": "vote_update", "payload": {"votes_cast": int(votes_cast or 0), "votes_total": int(votes_total or 0)}})
    if int(votes_cast or 0) >= int(votes_total or 0) and int(votes_total or 0) > 0:
        # закончить досрочно: отменяем таймер голосования и резолвим
        await timer_service.cancel_timer(session_id, "voting")
        await resolve_votes(session_id)
    return {"voter_player_id": str(player.id), "target_player_id": str(target_uuid) if target_uuid else None, "confirmed": True}


@router.get("/{session_id}/state")
async def state(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Фиксируем id до любого expire_all: current_user живёт в той же db-сессии
    # (общий Depends(get_db)), и expire_all() пометит его expired — тогда
    # обращение к current_user.id в async-контексте даёт sync lazy-load →
    # MissingGreenlet → 500. Локальный user_id безопасен.
    user_id = current_user.id
    session = await get_session_or_404(db, session_id)
    player = await get_player_or_404(db, session_id, user_id)
    set_log_context(session_id=str(session_id), user_id=str(user_id))
    if session.status == "waiting":
        raise GameError(403, "wrong_phase", "Игра ещё не началась")

    phase = await get_current_phase(db, session_id)
    if phase is None and session.status == "active":
        await recover_missing_phase(session_id)
        # recover_missing_phase коммитит в своей сессии; expire_all сбрасывает
        # кэш, чтобы увидеть новую фазу. Но он же делает session/player
        # expired — последующее обращение к их атрибутам в async-контексте
        # вызывает sync lazy-load → MissingGreenlet → 500. Поэтому
        # перезагружаем session/player отдельными await-запросами.
        db.expire_all()
        session = await get_session_or_404(db, session_id)
        player = await get_player_or_404(db, session_id, user_id)
        phase = await get_current_phase(db, session_id)
    if phase is None and session.status == "active":
        phase = await get_last_known_phase(db, session_id)

    restored = await restore_runtime_like_fields(db, session_id, phase)
    rt = runtime_state.get(session_id)
    previous_runtime = {
        "sub_phase": rt.day_sub_phase,
        "night_turn": rt.night_turn,
        "timer_name": rt.timer_name,
        "timer_seconds": rt.timer_seconds,
    }
    # если runtime потерян (рестарт), используем восстановленные значения
    if restored["sub_phase"] is not None:
        rt.day_sub_phase = restored["sub_phase"]
    if restored["night_turn"] is not None:
        rt.night_turn = restored["night_turn"]
    if restored["timer_name"] is not None:
        rt.timer_name = restored["timer_name"]
    if restored["timer_started_at"] is not None:
        rt.timer_started_at = restored["timer_started_at"]
    if restored["timer_seconds"] is not None:
        rt.timer_seconds = restored["timer_seconds"]
    rt.vote_round = int(restored.get("vote_round") or rt.vote_round or 1)
    if restored.get("candidate_ids") is not None:
        rt.voting_candidate_ids = restored["candidate_ids"]
    if restored.get("announcement") is not None and rt.current_announcement is None:
        rt.current_announcement = restored["announcement"]
    if any(
        restored.get(key) is not None and restored.get(key) != previous_runtime.get(key)
        for key in ("sub_phase", "night_turn", "timer_name", "timer_seconds")
    ):
        log_event(
            logger,
            logging.WARNING,
            "runtime_state_mismatch",
            "Runtime state restored from persisted events",
            session_id=str(session_id),
            user_id=str(user_id),
            restored=restored,
        )

    # роль игрока
    role = await db.get(Role, player.role_id) if player.role_id else None

    # Фича 2: визуальное переопределение роли для сюжета (имя + 2 карточки).
    # Логика роли (slug/team/abilities) не меняется — только display_name и
    # картинки карточек на стадии role_reveal.
    role_override: StoryRoleOverride | None = None
    if role is not None and session.story_id is not None:
        role_override = await db.scalar(
            select(StoryRoleOverride)
            .where(
                StoryRoleOverride.story_id == session.story_id,
                StoryRoleOverride.role_slug == role.slug,
            )
            .options(
                selectinload(StoryRoleOverride.card_front_image),
                selectinload(StoryRoleOverride.card_back_image),
            )
        )

    all_players = (
        await db.scalars(
            select(Player)
            .options(selectinload(Player.user))
            .where(Player.session_id == session_id)
        )
    ).all()

    paused = session_is_paused(session.settings)
    if paused:
        rt.game_paused = True

    is_blocked_tonight = (
        phase is not None
        and phase.phase_type == "night"
        and player.id in rt.blocked_tonight
    )

    # During pause, use the snapshot's remaining_seconds as timer_seconds and
    # set timer_started_at to "now" so the frontend's computeRemainingSeconds
    # shows the frozen value instead of a stale countdown hitting 0.
    effective_timer_seconds = rt.timer_seconds
    effective_timer_started_at = rt.timer_started_at.isoformat() if rt.timer_started_at else None
    # Fallback для role_reveal: phase_changed event для этой фазы не персистится,
    # поэтому после рестарта backend runtime пуст. Берём данные из самой фазы.
    if (
        phase is not None
        and phase.phase_type == "role_reveal"
        and (effective_timer_started_at is None or effective_timer_seconds is None)
    ):
        effective_timer_started_at = phase.started_at.isoformat()
        effective_timer_seconds = int((session.settings or {}).get("role_reveal_timer_seconds") or 15)
    if (
        phase is not None
        and phase.phase_type == "story_vote"
        and (effective_timer_started_at is None or effective_timer_seconds is None)
    ):
        effective_timer_started_at = phase.started_at.isoformat()
        effective_timer_seconds = int((session.settings or {}).get("story_vote_timer_seconds") or 30)
    if (
        phase is not None
        and phase.phase_type == "name_pick"
        and (effective_timer_started_at is None or effective_timer_seconds is None)
    ):
        effective_timer_started_at = phase.started_at.isoformat()
        effective_timer_seconds = int((session.settings or {}).get("name_pick_timer_seconds") or 60)
    if paused:
        gp_snap = ((session.settings or {}).get("game_pause") or {}).get("snapshot") or {}
        snap_remaining = gp_snap.get("remaining_seconds")
        if snap_remaining is not None:
            effective_timer_seconds = int(snap_remaining)
            effective_timer_started_at = datetime.now(timezone.utc).isoformat()

    response = {
        "session_status": session.status,
        "session_code": session.code,
        "game_paused": paused,
        "settings": session.settings or {},
        "phase": {
            "id": str(phase.id) if phase else None,
            "type": phase.phase_type if phase else None,
            "number": phase.phase_number if phase else None,
            "sub_phase": rt.day_sub_phase if phase and phase.phase_type == "day" else None,
            "night_turn": rt.night_turn if phase and phase.phase_type == "night" else None,
            "started_at": phase.started_at.isoformat() if phase else None,
            "timer_seconds": effective_timer_seconds,
            "timer_started_at": effective_timer_started_at,
            "vote_round": rt.vote_round if phase and phase.phase_type == "day" and rt.day_sub_phase == "voting" else 1,
        },
        "my_player": {
            "id": str(player.id),
            "name": player.name,
            "status": player.status,
            "role": (
                {
                    "slug": role.slug,
                    "name": role.name,
                    "team": role.team,
                    "abilities": role.abilities,
                    "display_name": (
                        role_override.display_name
                        if role_override and role_override.display_name
                        else role.name
                    ),
                    "description": (
                        role_override.description
                        if role_override and role_override.description
                        else None
                    ),
                    "card_front_url": (
                        f"/images/{role_override.card_front_image.storage_path}"
                        if role_override and role_override.card_front_image
                        else None
                    ),
                    "card_back_url": (
                        f"/images/{role_override.card_back_image.storage_path}"
                        if role_override and role_override.card_back_image
                        else None
                    ),
                }
                if role
                else {"slug": None, "name": None, "team": None, "abilities": {}}
            ),
            "is_blocked_tonight": is_blocked_tonight,
        },
        "players": [
            {
                "id": str(p.id),
                "name": p.name,
                "username": p.user.display_name if p.user else None,
                "status": p.status,
                "join_order": p.join_order,
            }
            for p in sorted(all_players, key=lambda x: x.join_order)
        ],
        "awaiting_action": False,
        "action_type": None,
        "available_targets": [],
        "my_action_submitted": False,
        "announcement": _ensure_announcement_started_at(rt.current_announcement, rt.announcement_started_at),
    }

    if phase and phase.phase_type == "day":
        response["day_blocked_player"] = (
            str(rt.day_blocked_player) if rt.day_blocked_player else None
        )

    if phase and phase.phase_type == "role_reveal":
        my_ack = await db.scalar(
            select(GameEvent.id).where(
                GameEvent.session_id == session_id,
                GameEvent.phase_id == phase.id,
                GameEvent.event_type == "role_acknowledged",
                GameEvent.payload["player_id"].astext == str(player.id),
            )
        )
        acked = await db.scalar(
            select(func.count(GameEvent.id)).where(
                GameEvent.session_id == session_id,
                GameEvent.phase_id == phase.id,
                GameEvent.event_type == "role_acknowledged",
            )
        )
        response["role_reveal"] = {
            "my_acknowledged": my_ack is not None,
            "players_acknowledged": int(acked or 0),
            "players_total": len(all_players),
        }

    if phase and phase.phase_type == "story_vote":
        from services.game_engine import _story_vote_card, _tally_story_votes, _votable_stories

        stories = await _votable_stories(db)
        counts, voted = await _tally_story_votes(db, session_id, phase.id)
        my_vote = await db.scalar(
            select(GameEvent.payload["story_id"].astext).where(
                GameEvent.session_id == session_id,
                GameEvent.phase_id == phase.id,
                GameEvent.event_type == "story_vote",
                GameEvent.payload["player_id"].astext == str(player.id),
            )
        )
        alive_total = sum(1 for p in all_players if p.status == "alive")
        response["story_vote"] = {
            "stories": [_story_vote_card(s) for s in stories],
            "counts": counts,
            "voted": voted,
            "alive_total": alive_total,
            "my_vote": my_vote,
        }

    if phase and phase.phase_type == "name_pick":
        options = await _name_pick_options(db, session)
        taken = [p.name for p in all_players if p.id != player.id]
        response["name_pick"] = {
            "names": options,
            "taken": taken,
            "my_name": player.name,
        }

    # awaiting action during night turn
    if phase and phase.phase_type == "night" and role:
        night_action = (role.abilities or {}).get("night_action")
        current_turn = rt.night_turn
        current_turn_matches = (
            (current_turn == "mafia" and night_action == "kill" and role.team == "mafia")
            or (current_turn == "doctor" and night_action == "heal")
            or (current_turn == "sheriff" and night_action == "check")
            or (current_turn == "don" and night_action == "don_check")
            or (current_turn == "lover" and night_action == "lover_visit")
            or (current_turn == "maniac" and night_action == "maniac_kill")
        )
        if night_action and current_turn_matches:
            response["action_type"] = night_action
            # Если заблокирован любовницей — действие недоступно.
            response["awaiting_action"] = not is_blocked_tonight

            # Подтянем роли остальных один раз, чтобы фильтровать мафию и т.п.
            other_role_ids = {p.role_id for p in all_players if p.role_id}
            roles_db = (
                (await db.scalars(select(Role).where(Role.id.in_(other_role_ids)))).all()
                if other_role_ids
                else []
            )
            roles_by_id = {r.id: r for r in roles_db}

            def _team_of(p: Player) -> str | None:
                if not p.role_id:
                    return None
                r = roles_by_id.get(p.role_id)
                return r.team if r else None

            if night_action == "kill":
                response["available_targets"] = [
                    _player_target_dict(p)
                    for p in all_players
                    if p.status == "alive" and p.id != player.id and _team_of(p) != "mafia"
                ]
            elif night_action == "heal":
                response["available_targets"] = [
                    _player_target_dict(p)
                    for p in all_players
                    if p.status == "alive"
                ]
            elif night_action == "check":
                response["available_targets"] = [
                    _player_target_dict(p)
                    for p in all_players
                    if p.status == "alive" and p.id != player.id
                ]
            elif night_action == "don_check":
                response["available_targets"] = [
                    _player_target_dict(p)
                    for p in all_players
                    if p.status == "alive" and p.id != player.id and _team_of(p) != "mafia"
                ]
            elif night_action == "lover_visit":
                response["available_targets"] = [
                    _player_target_dict(p)
                    for p in all_players
                    if p.status == "alive"
                    and p.id != player.id
                    and p.id != rt.lover_last_target
                ]
            elif night_action == "maniac_kill":
                response["available_targets"] = [
                    _player_target_dict(p)
                    for p in all_players
                    if p.status == "alive" and p.id != player.id
                ]

            submitted = await db.scalar(
                select(NightAction.id).where(
                    NightAction.phase_id == phase.id,
                    NightAction.actor_player_id == player.id,
                )
            )
            response["my_action_submitted"] = submitted is not None

    if phase and phase.phase_type == "day" and rt.day_sub_phase == "voting":
        cast = await db.scalar(select(func.count(DayVote.id)).where(DayVote.phase_id == phase.id))
        total_q = select(func.count(Player.id)).where(Player.session_id == session_id, Player.status == "alive")
        if rt.day_blocked_player is not None:
            total_q = total_q.where(Player.id != rt.day_blocked_player)
        total = await db.scalar(total_q)
        response["votes"] = {"total_expected": int(total or 0), "cast": int(cast or 0)}

        # Voting targets (alive except self, excluding blocked)
        is_voter_blocked = rt.day_blocked_player is not None and rt.day_blocked_player == player.id
        if player.status == "alive" and not is_voter_blocked:
            candidate_ids = set(rt.voting_candidate_ids or [])
            response["available_targets"] = [
                _player_target_dict(p)
                for p in all_players
                if p.status == "alive"
                and p.id != player.id
                and (not candidate_ids or p.id in candidate_ids)
            ]
            response["awaiting_action"] = True

        my_vote = await db.scalar(
            select(DayVote.id).where(DayVote.phase_id == phase.id, DayVote.voter_player_id == player.id)
        )
        response["my_vote_submitted"] = my_vote is not None

    if session.status == "finished" and phase is None:
        lp = await db.scalar(
            select(GamePhase)
            .where(GamePhase.session_id == session_id)
            .order_by(GamePhase.started_at.desc())
            .limit(1)
        )
        if lp:
            response["phase"] = {
                "id": str(lp.id),
                "type": lp.phase_type,
                "number": lp.phase_number,
                "sub_phase": None,
                "night_turn": None,
                "started_at": lp.started_at.isoformat(),
                "timer_seconds": None,
                "timer_started_at": None,
                "closed": True,
            }
        fin = await db.scalar(
            select(GameEvent)
            .where(GameEvent.session_id == session_id, GameEvent.event_type == "game_finished")
            .order_by(GameEvent.created_at.desc())
            .limit(1)
        )
        if fin and isinstance(fin.payload, dict):
            if fin.payload.get("winner"):
                response["winner"] = fin.payload["winner"]
            if fin.payload.get("players"):
                response["final_roster"] = fin.payload["players"]

    return response


@router.post("/{session_id}/reset-to-lobby")
async def reset_to_lobby(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Возвращает текущего игрока в лобби (индивидуально).

    Семантика:
      - status == "active" → 409.
      - status == "finished":
        * Если игрок ЕСТЬ в сессии — он первый нажавший: становится новым хостом,
          сбрасывает игру в waiting, удаляет всех других игроков. Они получат
          WS-event и при нажатии «Вернуться в лобби» вызовут join (через 403).
        * Если игрока в сессии НЕТ — другой игрок уже сбросил → 403, фронт делает join.
      - status == "waiting":
        * Если игрок уже в сессии — idempotent.
        * Если игрока нет — 403 (фронт пойдёт в join).
    """
    session = await get_session_or_404(db, session_id)

    if session.status == "active":
        raise GameError(409, "game_in_progress", "Игра ещё идёт")

    my_player = await db.scalar(
        select(Player).where(Player.session_id == session_id, Player.user_id == current_user.id)
    )

    if my_player is None:
        raise GameError(403, "not_in_session", "Сессия уже сброшена другим игроком — присоединитесь по коду")

    if session.status == "waiting":
        # Idempotent: уже в лобби, ничего не делаем.
        return {"status": "waiting", "session_code": session.code}

    # status == "finished" и я первый нажавший. Становлюсь хостом, удаляю других, сбрасываю игру.
    # Сначала удаляем game-data в правильном порядке (events до phases).
    phases = (await db.scalars(select(GamePhase.id).where(GamePhase.session_id == session_id))).all()
    if phases:
        await db.execute(sa_delete(NightAction).where(NightAction.phase_id.in_(phases)))
        await db.execute(sa_delete(DayVote).where(DayVote.phase_id.in_(phases)))
    await db.execute(sa_delete(GameEvent).where(GameEvent.session_id == session_id))
    await db.execute(sa_delete(GamePhase).where(GamePhase.session_id == session_id))
    # Story Engine: удаляем прогресс прошлой игры, иначе start_story при новой
    # игре «возобновит» сюжет с сохранённого current_step_id (роли не
    # перевыдаются, фазы скипаются). См. story_runtime.start_story.
    await db.execute(
        sa_delete(SessionStoryState).where(SessionStoryState.session_id == session_id)
    )

    # Удаляем всех игроков, кроме меня.
    await db.execute(
        sa_delete(Player).where(Player.session_id == session_id, Player.id != my_player.id)
    )

    # Сбрасываю себя — alive, без роли, join_order=1, имя — обратно на ник из
    # профиля (в игре name перезаписывается выбранным/сюжетным именем).
    my_player.status = "alive"
    my_player.role_id = None
    my_player.join_order = 1
    reset_name = (current_user.display_name or "").strip()
    if not reset_name:
        reset_name = current_user.email.split("@")[0]
    my_player.name = reset_name[:32]

    # Сбрасываю сессию.
    session.status = "waiting"
    session.ended_at = None
    # Сюжет выбирается заново в лобби / голосованием — обнуляем, чтобы новая
    # игра не тянула устаревший story_id.
    session.story_id = None
    session.host_user_id = current_user.id  # я теперь хост
    cur = clear_audio_preload(session.settings)
    cur.pop("game_pause", None)
    session.settings = cur

    await db.commit()

    # Clear runtime state
    await timer_service.cancel_all(session_id)
    runtime_state.clear(session_id)

    # Уведомляем всех (старые WS-соединения других игроков ещё открыты с финала),
    # чтобы они перешли на FinaleScreen → "Вернуться в лобби" работал корректно.
    await ws_manager.send_to_session(
        session_id,
        {
            "type": "session_reset",
            "payload": {
                "session_id": str(session_id),
                "session_code": session.code,
                "status": "waiting",
                "new_host_user_id": str(current_user.id),
            },
        },
    )
    return {"status": "waiting", "session_code": session.code}
