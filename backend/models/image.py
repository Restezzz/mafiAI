"""Модель загруженных картинок (аналог ``NarratorAudioFile`` для аудио).

Физически файлы лежат в ``settings.IMAGE_STORAGE_ROOT/storage_path`` и
отдаются через StaticFiles mount ``/images`` (см. ``main.py``).

Используется фичами Story Engine:
- карточки роли (``StoryRoleOverride.card_front_image_id`` / ``card_back_image_id``),
- обложка сюжета (``Story.cover_image_id``).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, String, TIMESTAMP, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base

if TYPE_CHECKING:
    from models.user import User


class ImageFile(Base):
    """Загруженная картинка. Хранится в ``settings.IMAGE_STORAGE_ROOT/storage_path``.

    URL для клиента собирается как ``/images/{storage_path}``.
    """

    __tablename__ = "image_files"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    filename: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    # Относительно IMAGE_STORAGE_ROOT, например 'uploads/abc...png'.
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )

    uploaded_by: Mapped["User | None"] = relationship(foreign_keys=[uploaded_by_id])
