"""Лог событий игры для реконнекта/восстановления состояния."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, TIMESTAMP, func, Index, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


class GameEvent(Base):
    __tablename__ = "game_events"

    __table_args__ = (
        CheckConstraint(
            "event_type IN ("
            "'player_joined', 'player_left', 'game_started', "
            "'player_renamed', "
            "'role_acknowledged', 'all_acknowledged', 'phase_changed', "
            "'night_action_submitted', 'night_result', 'player_eliminated', "
            "'vote_cast', 'vote_result', 'game_finished', 'session_closed'"
            ")",
            name="ck_game_events_type",
        ),
        Index("idx_game_events_session_created", "session_id", "created_at"),
        # Composite index для частых COUNT/SELECT по (session, phase, event_type) (#19):
        # acknowledge_role и /state часто гоняют WHERE session_id=? AND phase_id=? AND event_type=?
        Index("ix_game_events_session_phase_type", "session_id", "phase_id", "event_type"),
        # Partial unique index — защита от двойного role_acknowledged.
        # Создаётся миграцией 20260516_unique_role_ack (postgresql_where).
        Index(
            "uq_role_ack_session_phase_player",
            "session_id",
            "phase_id",
            text("(payload->>'player_id')"),
            unique=True,
            postgresql_where=text("event_type = 'role_acknowledged'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    phase_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("game_phases.id"), nullable=True
    )
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )

    session: Mapped["Session"] = relationship(back_populates="events")
    phase: Mapped["GamePhase | None"] = relationship()
