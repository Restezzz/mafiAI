"""Lobby роутер (список игроков, выход/кик, закрытие, настройки до старта)."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.deps import get_current_user, get_db, get_player_or_404, get_session_or_404, require_host
from core.exceptions import GameError
from core.logging import log_event, set_log_context
from models.game_event import GameEvent
from models.player import Player
from models.session import Session
from schemas.session import AudioPreloadReadyRequest, PlayerInList, RenamePlayerRequest, UpdateSettingsRequest
from services.audio_preload import (
    clear_audio_preload,
    get_audio_preload_status,
    mark_audio_preload_ready,
    session_audio_plan,
)
from services.dev_test_lobby_service import mark_synthetic_players_audio_ready
from services.game_engine import apply_host_kick
from services.lobby_service import handle_player_left
from services.pause_service import pause_game, resume_game
from services.session_service import validate_role_config
from services.timer_service import timer_service
from services.runtime_state import runtime_state
from services.ws_manager import ws_manager


router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/{session_id}/players")
async def list_players(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)

    players = (
        await db.scalars(
            select(Player)
            .options(selectinload(Player.user))
            .where(Player.session_id == session_id)
        )
    ).all()
    items = [
        PlayerInList(
            id=str(p.id),
            name=p.name,
            username=p.user.display_name if p.user else None,
            join_order=p.join_order,
            is_host=(p.user_id == session.host_user_id),
            is_me=(p.user_id == current_user.id),
        )
        for p in sorted(players, key=lambda x: x.join_order)
    ]
    return {"players": items}


@router.post("/{session_id}/begin-story")
async def begin_story(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Хост запускает этап выбора сюжета и имён персонажей.

    Не меняет статус сессии (остаётся `waiting`), но рассылает всем клиентам
    WS-событие `story_phase_started`, чтобы они перешли на страницу сюжета.
    Фактический старт игры (`gameApi.start`) происходит позже, когда хост
    завершит фазу выбора имён.
    """
    session = await get_session_or_404(db, session_id)
    require_host(session, current_user.id)
    if session.status != "waiting":
        raise GameError(409, "wrong_phase", "Нельзя начать выбор сюжета после старта игры")

    session.settings = clear_audio_preload(session.settings)
    # Dev-test "боты" не имеют открытой вкладки и не вызовут
    # /audio-preload-ready. Помечаем их сразу после очистки readiness-карты,
    # иначе фаза name-pick зависнет на ready_count < players_total и
    # gameApi.start вернёт 409 audio_not_ready (ensure_audio_preload_ready).
    await mark_synthetic_players_audio_ready(db, session)
    await db.commit()

    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    log_event(
        logger,
        logging.INFO,
        "session.story_phase_started",
        "Host started story phase",
        session_id=str(session_id),
        user_id=str(current_user.id),
    )

    await ws_manager.send_to_session(
        session_id,
        {"type": "story_phase_started", "payload": {}},
    )
    return {"ok": True}


@router.get("/{session_id}/audio-preload")
async def audio_preload_status(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    await get_player_or_404(db, session_id, current_user.id)
    return await get_audio_preload_status(db, session)


@router.get("/{session_id}/audio-preload/manifest")
async def audio_preload_manifest(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Набор URL'ов озвучки для предзагрузки: story-scoped для story-сессий,
    глобальный манифест для legacy. Фронт грузит только эти файлы."""
    session = await get_session_or_404(db, session_id)
    await get_player_or_404(db, session_id, current_user.id)
    return await session_audio_plan(db, session)


@router.post("/{session_id}/audio-preload-ready")
async def audio_preload_ready(
    session_id: uuid.UUID,
    payload: AudioPreloadReadyRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await get_session_or_404(db, session_id)
    player = await get_player_or_404(db, session_id, current_user.id)
    _, status = await mark_audio_preload_ready(
        db,
        session_id=session_id,
        player_id=player.id,
        manifest_version=payload.manifest_version,
    )
    await ws_manager.send_to_session(
        session_id,
        {"type": "audio_preload_ready", "payload": status},
    )
    return status


@router.patch("/{session_id}/players/me/name")
async def rename_my_player(
    session_id: uuid.UUID,
    payload: RenamePlayerRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Поменять имя своего игрока на одно из озвученных и уникальных в сессии.

    Используется на странице выбора сюжета: до старта игры каждый игрок
    финально выбирает себе имя из манифеста, чтобы озвучка работала корректно.
    """
    session = await get_session_or_404(db, session_id)
    if session.status != "waiting":
        raise GameError(409, "wrong_phase", "Имя можно менять только до старта игры")

    player = await get_player_or_404(db, session_id, current_user.id)

    new_name = payload.name
    # Уникальность среди других игроков сессии (своё текущее имя — допустимо).
    conflict = await db.scalar(
        select(Player).where(
            Player.session_id == session_id,
            Player.name == new_name,
            Player.id != player.id,
        )
    )
    if conflict is not None:
        raise GameError(409, "name_taken", "Это имя уже занято другим игроком")

    if player.name != new_name:
        player.name = new_name
        db.add(
            GameEvent(
                id=uuid.uuid4(),
                session_id=session_id,
                phase_id=None,
                event_type="player_renamed",
                payload={"player_id": str(player.id), "name": new_name},
            )
        )
        await db.commit()

        await ws_manager.send_to_session(
            session_id,
            {
                "type": "player_renamed",
                "payload": {"player_id": str(player.id), "name": new_name},
            },
        )

    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    log_event(
        logger,
        logging.INFO,
        "session.player_renamed",
        "Player renamed",
        session_id=str(session_id),
        user_id=str(current_user.id),
        player_id=str(player.id),
        new_name=new_name,
    )
    return {"player_id": str(player.id), "name": new_name}


@router.delete("/{session_id}/players/me", status_code=204)
async def leave_lobby(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    # Активной игры покидать нельзя (действие во время игры — отдельный flow с кик/выбыванием),
    # но из `waiting` и `finished` (после финала) — можно.
    if session.status == "active":
        raise GameError(409, "game_already_started", "Игра уже началась")

    player = await get_player_or_404(db, session_id, current_user.id)

    pid = player.id
    leaver_user_id = current_user.id
    await db.delete(player)

    # handle_player_left делает commit; при удалении сессии срабатывает CASCADE,
    # поэтому GameEvent `player_left` создаём ПОСЛЕ того, как убедились, что сессия
    # продолжает существовать.
    outcome = await handle_player_left(db, session, leaver_user_id)

    set_log_context(session_id=str(session_id), user_id=str(current_user.id))
    log_event(
        logger,
        logging.INFO,
        "session.left",
        "Player left lobby",
        session_id=str(session_id),
        user_id=str(current_user.id),
        player_id=str(pid),
        session_deleted=outcome.session_deleted,
        host_transferred=outcome.host_transferred,
    )

    if outcome.session_deleted:
        await ws_manager.close_session(session_id)
        return None

    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session_id,
            phase_id=None,
            event_type="player_left",
            payload={"player_id": str(pid)},
        )
    )
    await db.commit()

    await ws_manager.send_to_session(
        session_id, {"type": "player_left", "payload": {"player_id": str(pid)}}
    )
    if outcome.host_transferred:
        await ws_manager.send_to_session(
            session_id,
            {
                "type": "host_transferred",
                "payload": {
                    "new_host_user_id": str(outcome.new_host_user_id),
                    "new_host_player_id": str(outcome.new_host_player_id),
                    "new_host_name": outcome.new_host_name,
                    "previous_host_user_id": str(leaver_user_id),
                },
            },
        )
    return None


@router.delete("/{session_id}/players/{player_id}", status_code=204)
async def kick_player(
    session_id: uuid.UUID,
    player_id: uuid.UUID,
    confirm: bool = Query(False, description="Обязательно true при кике во время активной игры (подтверждение с клиента)"),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    require_host(session, current_user.id)

    player = await db.scalar(select(Player).where(Player.session_id == session_id, Player.id == player_id))
    if player is None:
        raise GameError(404, "player_not_found", "Игрок не найден в этой сессии")
    if player.user_id == current_user.id:
        raise GameError(403, "not_host", "Нельзя кикнуть себя")

    if session.status == "active":
        if not confirm:
            raise GameError(
                400,
                "confirmation_required",
                "Во время игры передайте query-параметр confirm=true после подтверждения пользователем",
            )
        await apply_host_kick(db, session, player)
        kicked_user_id = player.user_id
        await ws_manager.send_to_session(
            session_id,
            {
                "type": "player_kicked",
                "payload": {"player_id": str(player_id), "reason": "host_kicked"},
            },
        )
        await ws_manager.send_to_user(
            session_id, kicked_user_id, {"type": "kicked", "payload": {"reason": "host_kicked"}}
        )
        await ws_manager.close_connection(session_id, kicked_user_id, code=4000)
        log_event(
            logger,
            logging.INFO,
            "session.player_kicked",
            "Host kicked player during active game",
            session_id=str(session_id),
            user_id=str(current_user.id),
            player_id=str(player_id),
        )
        return None

    if session.status != "waiting":
        raise GameError(409, "game_already_started", "Игра уже началась или завершена")

    kicked_user_id = player.user_id
    await db.delete(player)
    await db.commit()

    await ws_manager.send_to_session(session_id, {"type": "player_left", "payload": {"player_id": str(player_id)}})
    await ws_manager.send_to_user(session_id, kicked_user_id, {"type": "kicked", "payload": {"reason": "host_kicked"}})
    await ws_manager.close_connection(session_id, kicked_user_id, code=4000)
    log_event(
        logger,
        logging.INFO,
        "session.player_kicked",
        "Host kicked player from lobby",
        session_id=str(session_id),
        user_id=str(current_user.id),
        player_id=str(player_id),
    )
    return None


@router.delete("/{session_id}", status_code=204)
async def close_session(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    require_host(session, current_user.id)

    session.status = "finished"
    session.ended_at = datetime.now(timezone.utc)
    cur_settings = clear_audio_preload(session.settings)
    cur_settings.pop("game_pause", None)
    session.settings = cur_settings
    await timer_service.cancel_all(session_id)
    runtime_state.clear(session_id)
    db.add(
        GameEvent(
            id=uuid.uuid4(),
            session_id=session_id,
            phase_id=None,
            event_type="session_closed",
            payload={},
        )
    )
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "session.closed",
        "Session closed by host",
        session_id=str(session_id),
        user_id=str(current_user.id),
    )

    await ws_manager.send_to_session(session_id, {"type": "session_closed", "payload": {}})
    await ws_manager.close_session(session_id)
    return None


@router.patch("/{session_id}/settings")
async def update_settings(
    session_id: uuid.UUID,
    payload: UpdateSettingsRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    require_host(session, current_user.id)
    if session.status != "waiting":
        raise GameError(409, "game_already_started", "Игра уже началась")

    current = session.settings or {}
    patch = payload.model_dump(exclude_unset=True)
    # role_config валидация (если передана)
    if patch.get("role_config") is not None:
        rc = patch["role_config"]
        civilian = validate_role_config(session.player_count, rc)
        patch["role_config"] = {**rc, "civilian": civilian}

    # Story Engine (этап 2.6): story_id и use_story_engine не идут в jsonb
    # session.settings — у Session уже есть отдельная FK-колонка story_id,
    # а use_story_engine остаётся в jsonb для compat-shim'а.
    if "story_id" in patch:
        story_id_value = patch.pop("story_id")
        if story_id_value is not None:
            # Локальный импорт чтобы не тянуть Story модель в каждый legacy
            # импорт lobby.py.
            from models.story import Story
            story = await db.scalar(
                select(Story).where(Story.id == story_id_value)
            )
            if story is None:
                raise GameError(404, "story_not_found", "Сюжет не найден")
            if story.is_obsolete:
                raise GameError(
                    409, "story_obsolete",
                    "Этот сюжет архивирован и не доступен для новых игр",
                )
            session.story_id = story_id_value
        else:
            session.story_id = None

    session.settings = {**current, **patch}
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "session.settings_updated",
        "Session settings updated",
        session_id=str(session_id),
        user_id=str(current_user.id),
        updated_fields=list(patch.keys()),
    )

    # Включаем story_id (FK-колонка, не в jsonb) в ответ, чтобы фронт
    # получил актуальное значение после смены сюжета.
    response_settings = {**session.settings}
    if session.story_id is not None:
        response_settings["story_id"] = str(session.story_id)
    else:
        response_settings.pop("story_id", None)

    await ws_manager.send_to_session(
        session_id,
        {"type": "settings_updated", "payload": {"settings": response_settings}},
    )
    return {"settings": response_settings}


@router.post("/{session_id}/pause")
async def pause_session(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    # Любой игрок сессии может поставить паузу (403, не 404).
    player = await db.scalar(
        select(Player).where(Player.session_id == session_id, Player.user_id == current_user.id)
    )
    if player is None:
        raise GameError(403, "player_not_found", "Вы не участник этой сессии")
    result = await pause_game(db, session)
    log_event(
        logger,
        logging.INFO,
        "game.paused",
        "Game paused",
        session_id=str(session_id),
        user_id=str(current_user.id),
    )
    return result


@router.post("/{session_id}/resume")
async def resume_session(
    session_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await get_session_or_404(db, session_id)
    # Любой игрок сессии может снять паузу (403, не 404).
    player = await db.scalar(
        select(Player).where(Player.session_id == session_id, Player.user_id == current_user.id)
    )
    if player is None:
        raise GameError(403, "player_not_found", "Вы не участник этой сессии")
    if session.status != "active":
        raise GameError(409, "wrong_phase", "Сессия не в игре")
    await resume_game(session_id)
    log_event(
        logger,
        logging.INFO,
        "game.resumed",
        "Game resumed",
        session_id=str(session_id),
        user_id=str(current_user.id),
    )
    return {"resumed": True}
