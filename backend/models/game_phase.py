"""Модель игровой фазы."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, TIMESTAMP, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class GamePhase(Base):
    """Фаза игры (день/ночь/голосование и т.д.)."""
    __tablename__ = "game_phases"

    __table_args__ = (
        UniqueConstraint("session_id", "phase_number", "phase_type", name="uq_phases_session_number_type"),
        CheckConstraint(
            "phase_type IN ('role_reveal', 'day', 'night', 'story_vote', 'name_pick')",
            name="ck_phases_type",
        ),
        # Partial composite index для get_current_phase (#19): запрос
        # WHERE session_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1
        # становится O(log N) вместо seq scan'а.
        Index(
            "ix_game_phases_session_active",
            "session_id",
            text("started_at DESC"),
            postgresql_where=text("ended_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    phase_type: Mapped[str] = mapped_column(String(15), nullable=False)
    phase_number: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )
    ended_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    # Связи
    session: Mapped["Session"] = relationship(
        back_populates="phases", foreign_keys=[session_id]
    )
    night_actions: Mapped[list["NightAction"]] = relationship(
        back_populates="phase", cascade="all, delete-orphan"
    )
    day_votes: Mapped[list["DayVote"]] = relationship(
        back_populates="phase", cascade="all, delete-orphan"
    )
