"""Story Engine 2.1: добавляем sessions.story_id + session_story_state.

Завязка сессии на сюжет:
- ``sessions.story_id`` (UUID nullable, FK → stories.id ON DELETE SET NULL):
  какой Story используется этой сессией. NULL = legacy-режим, не вовлечён
  Story Engine.
- Новая таблица ``session_story_state`` (1:1 c sessions, PK=session_id):
  runtime-состояние executor'а — ``current_step_id``, ``step_started_at``,
  ``step_vars`` (jsonb для условий transitions).

Compatibility flag хранится в jsonb-поле ``sessions.settings.use_story_engine``
и не требует миграции.

Revision ID: 20260527_session_story
Revises: 20260526_story_engine_tables
Create Date: 2026-05-27
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260527_session_story"
down_revision: Union[str, Sequence[str], None] = "20260526_story_engine_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. sessions.story_id
    op.add_column(
        "sessions",
        sa.Column(
            "story_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_sessions_story_id",
        source_table="sessions",
        referent_table="stories",
        local_cols=["story_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_sessions_story_id",
        "sessions",
        ["story_id"],
        unique=False,
    )

    # 2. session_story_state
    op.create_table(
        "session_story_state",
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "current_step_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("story_steps.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("step_started_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "step_vars",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # Индекс для admin-таблицы «сессии сейчас на шаге X» (этап 4).
    op.create_index(
        "ix_session_story_state_current_step",
        "session_story_state",
        ["current_step_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_session_story_state_current_step", table_name="session_story_state")
    op.drop_table("session_story_state")
    op.drop_index("ix_sessions_story_id", table_name="sessions")
    op.drop_constraint("fk_sessions_story_id", "sessions", type_="foreignkey")
    op.drop_column("sessions", "story_id")
