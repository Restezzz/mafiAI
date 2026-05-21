"""Dev-only helpers for creating playable synthetic test lobbies."""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.deps import get_db, require_admin_or_dev_env
from core.exceptions import GameError
from core.logging import log_event, set_log_context
from models.dev_test_lobby_link import DevTestLobbyLink
from models.player import Player
from models.refresh_token import RefreshToken
from models.session import Session
from models.user import User
from schemas.auth import MeResponse
from schemas.dev import ActivateDevPlayerRequest, ActivateDevPlayerResponse
from schemas.session import SessionDetailResponse
from services.auth_service import (
    create_access_token,
    create_refresh_token,
    hash_refresh_token,
    refresh_expires_at,
)
from services.dev_test_lobby_service import (
    DEFAULT_TEST_LOBBY_PLAYER_COUNT,
    MAX_TEST_LOBBY_PLAYER_COUNT,
    apply_dev_test_lobby_flag,
    build_session_detail_response,
    create_synthetic_test_player,
    is_dev_test_lobby,
)
from services.session_service import generate_unique_code, validate_role_config
from services.ws_manager import ws_manager


router = APIRouter()
logger = logging.getLogger(__name__)


def _default_test_lobby_settings(player_count: int) -> dict:
    role_config = {
        "mafia": 1,
        "don": 0,
        "sheriff": 1,
        "doctor": 1,
        "lover": 0,
        "maniac": 0,
    }
    civilian = validate_role_config(player_count, role_config)
    return apply_dev_test_lobby_flag(
        {
            "role_reveal_timer_seconds": 15,
            "discussion_timer_seconds": 120,
            "voting_timer_seconds": 60,
            "night_action_timer_seconds": 30,
            "role_config": {**role_config, "civilian": civilian},
        }
    )


async def _get_dev_test_session_or_404(db: AsyncSession, session_id: uuid.UUID) -> Session:
    session = await db.scalar(
        select(Session)
        .execution_options(populate_existing=True)
        .options(selectinload(Session.players).selectinload(Player.user))
        .where(Session.id == session_id)
    )
    if session is None:
        raise GameError(404, "session_not_found", "Сессия не найдена")
    if not is_dev_test_lobby(session):
        raise GameError(404, "session_not_found", "Сессия не найдена")
    return session


@router.post("/test-lobbies", response_model=SessionDetailResponse, status_code=201)
async def create_test_lobby(
    current_user: User = Depends(require_admin_or_dev_env),
    db: AsyncSession = Depends(get_db),
) -> SessionDetailResponse:
    current_user_id = current_user.id
    player_count = DEFAULT_TEST_LOBBY_PLAYER_COUNT
    code = await generate_unique_code(db)
    session = Session(
        id=uuid.uuid4(),
        code=code,
        host_user_id=current_user_id,
        player_count=player_count,
        status="waiting",
        settings=_default_test_lobby_settings(player_count),
    )
    db.add(session)
    await db.flush()

    host_player = Player(
        id=uuid.uuid4(),
        session_id=session.id,
        user_id=current_user_id,
        name=(current_user.display_name or current_user.email.split("@")[0])[:32],
        join_order=1,
        status="alive",
        role_id=None,
    )
    host_link = DevTestLobbyLink(
        id=uuid.uuid4(),
        session_id=session.id,
        user_id=current_user_id,
        slot_number=1,
        player_slug="player1",
        bootstrap_key="host",
    )
    db.add(host_player)
    db.add(host_link)

    for slot_number in range(2, player_count + 1):
        await create_synthetic_test_player(
            db,
            session,
            slot_number,
            created_by_host_id=current_user_id,
        )

    session_id = session.id
    await db.commit()
    db.expire_all()
    session = await _get_dev_test_session_or_404(db, session_id)
    set_log_context(session_id=str(session.id), user_id=str(current_user_id))
    log_event(
        logger,
        logging.INFO,
        "dev.test_lobby_created",
        "Dev test lobby created",
        session_id=str(session.id),
        user_id=str(current_user_id),
        player_count=player_count,
    )
    return await build_session_detail_response(db, session, current_user_id)


@router.post("/test-lobbies/{session_id}/expand", response_model=SessionDetailResponse)
async def expand_test_lobby(
    session_id: uuid.UUID,
    current_user: User = Depends(require_admin_or_dev_env),
    db: AsyncSession = Depends(get_db),
) -> SessionDetailResponse:
    current_user_id = current_user.id
    session = await _get_dev_test_session_or_404(db, session_id)
    if session.host_user_id != current_user_id:
        raise GameError(403, "not_host", "Только организатор может выполнить это действие")
    if session.status != "waiting":
        raise GameError(409, "game_already_started", "Игра уже началась")
    if session.player_count >= MAX_TEST_LOBBY_PLAYER_COUNT:
        raise GameError(400, "validation_error", "Достигнут максимум тестовых игроков")

    next_slot = session.player_count + 1
    session.player_count = next_slot
    current_settings = dict(session.settings or {})
    role_config = dict(current_settings.get("role_config") or {})
    civilian = validate_role_config(next_slot, role_config)
    current_settings["role_config"] = {**role_config, "civilian": civilian}
    session.settings = current_settings
    await create_synthetic_test_player(
        db,
        session,
        next_slot,
        created_by_host_id=current_user_id,
    )
    current_session_id = session.id
    await db.commit()

    db.expire_all()
    session = await _get_dev_test_session_or_404(db, current_session_id)
    new_player = next((player for player in session.players if player.join_order == next_slot), None)
    if new_player is not None:
        await ws_manager.send_to_session(
            session.id,
            {
                "type": "player_joined",
                "payload": {
                    "id": str(new_player.id),
                    "name": new_player.name,
                    "username": new_player.user.display_name if new_player.user else None,
                    "join_order": new_player.join_order,
                    "is_host": False,
                },
            },
        )
    await ws_manager.send_to_session(
        session.id,
        {"type": "settings_updated", "payload": {"settings": session.settings}},
    )
    log_event(
        logger,
        logging.INFO,
        "dev.test_lobby_expanded",
        "Dev test lobby expanded",
        session_id=str(session.id),
        user_id=str(current_user_id),
        player_count=session.player_count,
    )
    return await build_session_detail_response(db, session, current_user_id)


MIN_TEST_LOBBY_PLAYER_COUNT = 3


@router.post("/test-lobbies/{session_id}/shrink", response_model=SessionDetailResponse)
async def shrink_test_lobby(
    session_id: uuid.UUID,
    current_user: User = Depends(require_admin_or_dev_env),
    db: AsyncSession = Depends(get_db),
) -> SessionDetailResponse:
    current_user_id = current_user.id
    session = await _get_dev_test_session_or_404(db, session_id)
    if session.host_user_id != current_user_id:
        raise GameError(403, "not_host", "Только организатор может выполнить это действие")
    if session.status != "waiting":
        raise GameError(409, "game_already_started", "Игра уже началась")
    if session.player_count <= MIN_TEST_LOBBY_PLAYER_COUNT:
        raise GameError(400, "validation_error", "Достигнут минимум тестовых игроков")

    last_slot = session.player_count
    last_player = next(
        (p for p in session.players if p.join_order == last_slot), None
    )
    if last_player is None:
        raise GameError(404, "player_not_found", "Последний игрок не найден")

    removed_player_id = str(last_player.id)
    removed_user_id = last_player.user_id

    # Delete link, player, then synthetic user
    link = await db.scalar(
        select(DevTestLobbyLink).where(
            DevTestLobbyLink.session_id == session.id,
            DevTestLobbyLink.slot_number == last_slot,
        )
    )
    if link:
        await db.delete(link)
    await db.delete(last_player)
    await db.flush()

    # Delete the synthetic user (safe — only dev users are created by this flow)
    removed_user = await db.get(User, removed_user_id)
    if removed_user is not None:
        await db.delete(removed_user)

    session.player_count = last_slot - 1
    current_settings = dict(session.settings or {})
    role_config = dict(current_settings.get("role_config") or {})
    civilian = validate_role_config(session.player_count, role_config)
    current_settings["role_config"] = {**role_config, "civilian": civilian}
    session.settings = current_settings

    current_session_id = session.id
    await db.commit()

    db.expire_all()
    session = await _get_dev_test_session_or_404(db, current_session_id)

    await ws_manager.send_to_session(
        session.id,
        {"type": "player_left", "payload": {"player_id": removed_player_id}},
    )
    await ws_manager.send_to_session(
        session.id,
        {"type": "settings_updated", "payload": {"settings": session.settings}},
    )
    log_event(
        logger,
        logging.INFO,
        "dev.test_lobby_shrunk",
        "Dev test lobby shrunk",
        session_id=str(session.id),
        user_id=str(current_user_id),
        player_count=session.player_count,
    )
    return await build_session_detail_response(db, session, current_user_id)


@router.post("/test-lobbies/activate", response_model=ActivateDevPlayerResponse)
async def activate_test_lobby_player(
    payload: ActivateDevPlayerRequest,
    db: AsyncSession = Depends(get_db),
) -> ActivateDevPlayerResponse:
    session = await db.scalar(select(Session).where(Session.code == payload.code))
    if session is None or not is_dev_test_lobby(session):
        raise GameError(404, "session_not_found", "Сессия не найдена")

    link = await db.scalar(
        select(DevTestLobbyLink).where(
            DevTestLobbyLink.session_id == session.id,
            DevTestLobbyLink.player_slug == payload.player_slug,
        )
    )
    if link is None or link.bootstrap_key != payload.bootstrap_key:
        raise GameError(401, "token_invalid", "Невалидная ссылка игрока")

    user = await db.get(User, link.user_id)
    if user is None:
        raise GameError(401, "token_invalid", "Пользователь не найден")

    access_token = create_access_token(str(user.id), user.email)
    refresh_token = create_refresh_token()
    db.add(
        RefreshToken(
            id=uuid.uuid4(),
            user_id=user.id,
            token_hash=hash_refresh_token(refresh_token),
            expires_at=refresh_expires_at(),
        )
    )
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "dev.test_lobby_player_activated",
        "Dev test lobby player link activated",
        session_id=str(session.id),
        user_id=str(user.id),
        player_slug=payload.player_slug,
    )
    return ActivateDevPlayerResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        user=MeResponse(
            user_id=str(user.id),
            email=user.email,
            nickname=user.display_name,
            has_pro=False,
            created_at=user.created_at.isoformat() if user.created_at else "",
        ),
    )
