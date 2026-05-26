"""Публичный (не админский) API сюжетов — для lobby UI.

Содержит один endpoint: GET /api/stories — список активных и не-obsolete
сюжетов, минимальный набор полей. Гейтирован ``get_current_user`` (не
``require_admin``), потому что любой залогиненный игрок-хост должен иметь
возможность выбрать сюжет для своей сессии.

Полное CRUD управление — через ``api/routers/admin_stories.py`` под
require_admin.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_db
from models.story import Story
from models.user import User


logger = logging.getLogger(__name__)

router = APIRouter()


class PublicStoryItem(BaseModel):
    id: str
    slug: str
    version: int
    name: str
    description: str | None


class PublicStoriesListResponse(BaseModel):
    stories: list[PublicStoryItem]


@router.get("", response_model=PublicStoriesListResponse)
async def list_stories(
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PublicStoriesListResponse:
    """Список активных сюжетов для выбора в lobby.

    Возвращает только ``is_active=true AND is_obsolete=false`` записи —
    архивные/устаревшие версии не предлагаются.
    """
    stmt = (
        select(Story)
        .where(Story.is_active.is_(True), Story.is_obsolete.is_(False))
        .order_by(Story.slug)
    )
    stories = (await db.scalars(stmt)).all()
    return PublicStoriesListResponse(
        stories=[
            PublicStoryItem(
                id=str(s.id),
                slug=s.slug,
                version=s.version,
                name=s.name,
                description=s.description,
            )
            for s in stories
        ]
    )
