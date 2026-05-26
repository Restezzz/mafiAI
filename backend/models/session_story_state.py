"""SessionStoryState — runtime-состояние Story Engine для конкретной сессии.

Одна запись на сессию (PK = session_id). Хранит:
- ``current_step_id`` — на каком шаге сюжета сейчас находится сессия.
  Может быть NULL если игра ещё не начата или уже закончена.
- ``step_started_at`` — когда вошли в текущий шаг (для UI «таймер фразы» и
  для recovery_loop при крэше воркера).
- ``step_vars`` — jsonb с вычисленными в predecessor-шагах значениями
  (например `winner_team`, `died_role`), которые ниже по графу будут
  использоваться в expressive conditions transitions.

Отдельная таблица (а не jsonb-поле в `sessions`) выбрана чтобы:
- иметь FK на `story_steps` (cascade-aware: нельзя удалить шаг пока есть
  активная сессия на нём — это покрывается в этапе 2.5);
- иметь индекс по ``current_step_id`` для admin-таблицы «активные сессии
  по шагам» (этап 4).

См. backend/docs/story_engine_design.md §11.1 (этап 2).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, TIMESTAMP, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base

if TYPE_CHECKING:
    from models.session import Session
    from models.story import StoryStep


class SessionStoryState(Base):
    __tablename__ = "session_story_state"

    # Жёсткий 1:1 c sessions: session_id одновременно PK и FK.
    # ON DELETE CASCADE: при удалении сессии state зачищается автоматически.
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        primary_key=True,
    )

    # ON DELETE SET NULL: если шаг удалили (например через cascade при удалении
    # сюжета), сессия остаётся, но executor увидит null и зайдёт в abort/recovery.
    current_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("story_steps.id", ondelete="SET NULL"),
        nullable=True,
    )

    step_started_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )

    # step_vars: общая «scratch-pad» памяти для условий transitions.
    # Примеры ключей:
    #   - winner_team: 'city'|'mafia'|'maniac'|null
    #   - died_role:   'mafia'|'sheriff'|...|null (последняя смерть)
    #   - death_cause: 'vote'|'night'|null
    #   - vote_tie:    bool
    #   - phase_number: int (номер ночи/дня)
    # См. design doc §3.4 для полного списка.
    step_vars: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="story_state")
    current_step: Mapped["StoryStep | None"] = relationship()
