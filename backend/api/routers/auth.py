"""Auth роутер (email+password, JWT, refresh rotation).

Отвечает за регистрацию/логин/refresh/logout и выдачу токенов.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_db, has_active_pro
from core.exceptions import GameError
from core.logging import log_event, set_log_context
from core.rate_limit import limiter
from models.refresh_token import RefreshToken
from models.user import User
from schemas.auth import (
    AuthResponse,
    DeleteAccountRequest,
    LoginRequest,
    LogoutRequest,
    MeResponse,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UpdateAvatarRequest,
    UpdateNicknameRequest,
)
from services.auth_service import (
    create_access_token,
    create_refresh_token,
    delete_user_account,
    hash_password,
    hash_refresh_token,
    refresh_expires_at,
    verify_password,
)


router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/register", response_model=AuthResponse, status_code=201)
@limiter.limit("5/hour")
async def register(
    request: Request,
    response: Response,
    payload: RegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    existing = await db.scalar(select(User).where(User.email == payload.email))
    if existing is not None:
        raise GameError(409, "email_already_registered", "Этот email уже зарегистрирован")

    user = User(
        id=uuid.uuid4(),
        email=payload.email,
        display_name=payload.nickname,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    await db.flush()

    access = create_access_token(str(user.id), user.email)
    refresh = create_refresh_token()
    db.add(
        RefreshToken(
            id=uuid.uuid4(),
            user_id=user.id,
            token_hash=hash_refresh_token(refresh),
            expires_at=refresh_expires_at(),
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise GameError(409, "email_already_registered", "Этот email уже зарегистрирован")
    set_log_context(user_id=str(user.id))
    log_event(logger, logging.INFO, "auth.register_succeeded", "User registered", user_id=str(user.id))

    return AuthResponse(
        user_id=str(user.id),
        email=user.email,
        nickname=user.display_name,
        access_token=access,
        refresh_token=refresh,
    )


@router.post("/login", response_model=AuthResponse)
@limiter.limit("10/5minutes")
async def login(
    request: Request,
    response: Response,
    payload: LoginRequest,
    db: AsyncSession = Depends(get_db),
) -> AuthResponse:
    user = await db.scalar(select(User).where(User.email == payload.email))
    if user is None:
        raise GameError(401, "invalid_credentials", "Неверный email или пароль")
    if not verify_password(payload.password, user.password_hash):
        raise GameError(401, "invalid_credentials", "Неверный email или пароль")

    access = create_access_token(str(user.id), user.email)
    refresh = create_refresh_token()
    db.add(
        RefreshToken(
            id=uuid.uuid4(),
            user_id=user.id,
            token_hash=hash_refresh_token(refresh),
            expires_at=refresh_expires_at(),
        )
    )
    await db.commit()
    set_log_context(user_id=str(user.id))
    log_event(logger, logging.INFO, "auth.login_succeeded", "User logged in", user_id=str(user.id))

    return AuthResponse(
        user_id=str(user.id),
        email=user.email,
        nickname=user.display_name,
        access_token=access,
        refresh_token=refresh,
    )


@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("30/5minutes")
async def refresh(
    request: Request,
    response: Response,
    payload: RefreshRequest,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    now = datetime.now(timezone.utc)
    token_hash = hash_refresh_token(payload.refresh_token)

    rt = await db.scalar(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    if rt is None:
        raise GameError(401, "token_invalid", "Refresh токен не найден или уже использован")

    # Reuse detection: токен уже отзывался → угон, инвалидируем все активные.
    if rt.revoked_at is not None:
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == rt.user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await db.commit()
        log_event(
            logger,
            logging.WARNING,
            "auth.refresh_reuse_detected",
            "Refresh token reuse detected; all user tokens revoked",
            user_id=str(rt.user_id),
        )
        raise GameError(401, "token_invalid", "Refresh токен не найден или уже использован")

    if rt.expires_at < now:
        rt.revoked_at = now
        await db.commit()
        raise GameError(401, "token_expired", "Срок действия токена истёк")

    user = await db.get(User, rt.user_id)
    if user is None:
        rt.revoked_at = now
        await db.commit()
        raise GameError(401, "token_invalid", "Refresh токен не найден или уже использован")

    # rotation: soft-revoke использованного токена для reuse-detection.
    rt.revoked_at = now

    access = create_access_token(str(user.id), user.email)
    refresh_token = create_refresh_token()
    db.add(
        RefreshToken(
            id=uuid.uuid4(),
            user_id=user.id,
            token_hash=hash_refresh_token(refresh_token),
            expires_at=refresh_expires_at(now),
        )
    )
    await db.commit()
    set_log_context(user_id=str(user.id))
    log_event(logger, logging.INFO, "auth.token_refreshed", "Refresh token rotated", user_id=str(user.id))

    return TokenResponse(access_token=access, refresh_token=refresh_token)


async def _me_response(user: User, db: AsyncSession) -> MeResponse:
    return MeResponse(
        user_id=str(user.id),
        email=user.email,
        nickname=user.display_name,
        has_pro=await has_active_pro(db, user.id),
        is_admin=user.is_admin,
        created_at=user.created_at.isoformat(),
        avatar_url=user.avatar_url,
    )


@router.get("/me", response_model=MeResponse)
async def me(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> MeResponse:
    return await _me_response(current_user, db)


@router.patch("/me", response_model=MeResponse)
async def update_me_nickname(
    payload: UpdateNicknameRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MeResponse:
    current_user.display_name = payload.nickname
    await db.commit()
    await db.refresh(current_user)
    log_event(
        logger,
        logging.INFO,
        "auth.profile_updated",
        "User nickname updated",
        user_id=str(current_user.id),
    )
    return await _me_response(current_user, db)


@router.put("/me/avatar", response_model=MeResponse)
async def update_me_avatar(
    payload: UpdateAvatarRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MeResponse:
    """Сохраняет аватарку как base64 data URL в users.avatar_url.

    `avatar_data_url=null` удаляет аватарку. Размер ограничен ~200КБ —
    клиент должен сжать canvas'ом до ~50КБ перед отправкой.
    """
    current_user.avatar_url = payload.avatar_data_url
    await db.commit()
    await db.refresh(current_user)
    log_event(
        logger,
        logging.INFO,
        "auth.avatar_updated",
        "User avatar updated",
        user_id=str(current_user.id),
        avatar_set=payload.avatar_data_url is not None,
    )
    return await _me_response(current_user, db)


@router.delete("/me", status_code=204)
async def delete_account(
    payload: DeleteAccountRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    if not verify_password(payload.password, current_user.password_hash):
        raise GameError(401, "invalid_credentials", "Неверный пароль")
    await delete_user_account(db, current_user.id)
    log_event(logger, logging.INFO, "auth.account_deleted", "User account deleted", user_id=str(current_user.id))
    return None


@router.post("/logout", status_code=204)
async def logout(
    payload: LogoutRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    token_hash = hash_refresh_token(payload.refresh_token)
    # Soft-revoke вместо delete: запись остаётся для reuse-detection в /refresh.
    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.user_id == current_user.id,
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(timezone.utc))
    )
    await db.commit()
    log_event(logger, logging.INFO, "auth.logout_succeeded", "User logged out", user_id=str(current_user.id))
    return None
