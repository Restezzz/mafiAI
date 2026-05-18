"""Модель пользователя."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, String, Text, TIMESTAMP, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(32), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    # Хранится как data:image/...;base64,... — фронт сжимает до ~50КБ.
    # Для серьёзного продакшена стоит вынести в S3/MinIO.
    avatar_url: Mapped[str | None] = mapped_column(Text(), nullable=True)
    # Доступ к админ-панели narrator. По-умолчанию false, выставляется вручную через SQL.
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )

    sessions: Mapped[list["Session"]] = relationship(back_populates="host_user")
    players: Mapped[list["Player"]] = relationship(back_populates="user")
    subscriptions: Mapped[list["Subscription"]] = relationship(back_populates="user")
