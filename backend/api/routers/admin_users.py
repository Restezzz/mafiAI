"""Admin endpoints для управления админскими правами пользователей.

Все эндпоинты гейтированы ``require_admin`` (см. api/deps.py). Содержит:
- GET /users — список юзеров с фильтром по email/display_name
- POST /users/{id}/promote — выдать is_admin=true
- POST /users/{id}/demote — снять is_admin (запрет self-demote)
- POST /users/promote-by-email — выдать админа по email (для quick-form)

is_admin не выдаётся через /api/auth/* — только через эту панель или
напрямую SQL-миграцией. См. backend/alembic/versions/20260518_users_is_admin.py.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, require_admin
from core.exceptions import GameError
from core.logging import log_event
from models.user import User


logger = logging.getLogger(__name__)

router = APIRouter()


class AdminUserItem(BaseModel):
    id: str
    email: str
    display_name: str
    is_admin: bool
    created_at: str | None = None


class AdminUsersListResponse(BaseModel):
    users: list[AdminUserItem]
    total: int


class PromoteByEmailPayload(BaseModel):
    email: EmailStr


def _serialize_user(u: User) -> AdminUserItem:
    return AdminUserItem(
        id=str(u.id),
        email=u.email,
        display_name=u.display_name,
        is_admin=u.is_admin,
        created_at=u.created_at.isoformat() if u.created_at else None,
    )


@router.get("/users", response_model=AdminUsersListResponse)
async def list_users(
    q: str | None = Query(default=None, description="Поиск по email или display_name (ILIKE)"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUsersListResponse:
    """Список юзеров с поиском (case-insensitive подстрока) и пагинацией.

    Сортировка: сначала админы, затем по email.
    """
    base_stmt = select(User)
    count_stmt = select(func.count()).select_from(User)
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        cond = or_(User.email.ilike(pattern), User.display_name.ilike(pattern))
        base_stmt = base_stmt.where(cond)
        count_stmt = count_stmt.where(cond)

    base_stmt = (
        base_stmt.order_by(User.is_admin.desc(), User.email.asc())
        .limit(limit)
        .offset(offset)
    )
    users = (await db.scalars(base_stmt)).all()
    total = int((await db.scalar(count_stmt)) or 0)
    return AdminUsersListResponse(
        users=[_serialize_user(u) for u in users],
        total=total,
    )


@router.post("/users/{user_id}/promote", response_model=AdminUserItem)
async def promote_user(
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserItem:
    """Выдаёт is_admin=true указанному юзеру. Идемпотентно."""
    user = await db.get(User, user_id)
    if user is None:
        raise GameError(404, "user_not_found", "Пользователь не найден")
    if not user.is_admin:
        user.is_admin = True
        await db.commit()
        await db.refresh(user)
        log_event(
            logger,
            logging.INFO,
            "admin.user_promoted",
            "Granted admin role",
            user_id=str(user.id),
            email=user.email,
            granted_by_id=str(admin.id),
            granted_by_email=admin.email,
        )
    return _serialize_user(user)


@router.post("/users/{user_id}/demote", response_model=AdminUserItem)
async def demote_user(
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserItem:
    """Снимает is_admin указанного юзера. Запрет self-demote — иначе
    можно случайно остаться без админа в системе. Идемпотентно.
    """
    if user_id == admin.id:
        raise GameError(400, "self_demote_forbidden", "Нельзя снять админ-роль с себя")
    user = await db.get(User, user_id)
    if user is None:
        raise GameError(404, "user_not_found", "Пользователь не найден")
    if user.is_admin:
        user.is_admin = False
        await db.commit()
        await db.refresh(user)
        log_event(
            logger,
            logging.INFO,
            "admin.user_demoted",
            "Revoked admin role",
            user_id=str(user.id),
            email=user.email,
            revoked_by_id=str(admin.id),
            revoked_by_email=admin.email,
        )
    return _serialize_user(user)


@router.post("/users/promote-by-email", response_model=AdminUserItem)
async def promote_user_by_email(
    payload: PromoteByEmailPayload,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserItem:
    """Выдаёт is_admin по email. LOWER(email) для устойчивости к регистру.

    Используется quick-form'ой в админке — админу не нужно сначала искать
    юзера в списке если он точно знает email. 404 если юзер не найден
    (он должен сначала зарегистрироваться).
    """
    target_email = payload.email.lower()
    user = await db.scalar(
        select(User).where(func.lower(User.email) == target_email)
    )
    if user is None:
        raise GameError(404, "user_not_found", "Пользователь с таким email не найден")
    if not user.is_admin:
        user.is_admin = True
        await db.commit()
        await db.refresh(user)
        log_event(
            logger,
            logging.INFO,
            "admin.user_promoted",
            "Granted admin role (by email)",
            user_id=str(user.id),
            email=user.email,
            granted_by_id=str(admin.id),
            granted_by_email=admin.email,
        )
    return _serialize_user(user)
