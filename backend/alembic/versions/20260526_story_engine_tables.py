"""story engine: stories, story_settings, story_steps, story_narration_cues, story_transitions

Создаёт фундамент для редактируемого графа сюжета (story engine).
Подробное описание схемы — backend/docs/story_engine_design.md.

Особенности:
- Циклический FK: ``stories.entry_step_id`` → ``story_steps.id`` и
  ``story_steps.story_id`` → ``stories.id``. Используем ``use_alter=True``
  и создаём FK на entry_step_id отдельным op.create_foreign_key ПОСЛЕ
  создания обеих таблиц.
- Partial unique index ``ix_stories_active_slug`` гарантирует ровно один
  ``is_active=TRUE`` на ``slug`` (поверх обычного UNIQUE(slug, version)).
- ``check_constraint`` на ``story_steps.kind`` повторяется в SQLAlchemy
  модели — изменения требуют синхронной правки обоих мест.

Никаких данных эта миграция не сидит. Seed «Классическая Мафия» делается
идемпотентно из ``services.story_seed.ensure_classic_mafia_story`` на
старте backend (по аналогии с ``ensure_role_catalog``).

Revision ID: 20260526_story_engine_tables
Revises: 20260521_promote_initial_admin
Create Date: 2026-05-26
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260526_story_engine_tables"
down_revision: Union[str, Sequence[str], None] = "20260521_promote_initial_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. stories: entry_step_id оставляем NULL на этапе создания таблицы,
    #    FK добавим после story_steps (циклика).
    op.create_table(
        "stories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(80), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_obsolete", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "superseded_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "entry_step_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
            # FK добавим ниже через op.create_foreign_key
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("slug", "version", name="uq_stories_slug_version"),
    )
    op.create_index("ix_stories_slug", "stories", ["slug"])
    # Partial unique: ровно одна active-версия на slug.
    op.execute(
        "CREATE UNIQUE INDEX ix_stories_active_slug "
        "ON stories(slug) WHERE is_active = TRUE"
    )

    # 2. story_steps: основная таблица узлов.
    op.create_table(
        "story_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "story_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("slug", sa.String(80), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("label", sa.String(120), nullable=False, server_default=""),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("position_x", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("position_y", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("story_id", "slug", name="uq_story_steps_story_slug"),
        sa.CheckConstraint(
            "kind IN ('narration', 'role_action', 'discussion', 'voting', "
            "'night_resolve', 'day_resolve', 'pause', 'branch', 'end')",
            name="ck_story_steps_kind",
        ),
    )
    op.create_index("ix_story_steps_story_id", "story_steps", ["story_id"])

    # 3. Теперь можем создать FK на stories.entry_step_id → story_steps.id
    op.create_foreign_key(
        "fk_stories_entry_step_id",
        "stories",
        "story_steps",
        ["entry_step_id"],
        ["id"],
        ondelete="SET NULL",
        use_alter=True,
    )

    # 4. story_settings 1:1.
    op.create_table(
        "story_settings",
        sa.Column(
            "story_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "inter_cue_pause_seconds",
            sa.Numeric(4, 2),
            nullable=False,
            server_default="0.00",
        ),
        sa.Column(
            "timer_multiplier_default",
            sa.Numeric(3, 2),
            nullable=False,
            server_default="1.00",
        ),
        sa.Column(
            "karaoke_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.CheckConstraint(
            "inter_cue_pause_seconds >= 0 AND inter_cue_pause_seconds <= 60",
            name="ck_story_settings_inter_cue_range",
        ),
        sa.CheckConstraint(
            "timer_multiplier_default >= 0.5 AND timer_multiplier_default <= 2",
            name="ck_story_settings_multiplier_range",
        ),
    )

    # 5. story_narration_cues.
    op.create_table(
        "story_narration_cues",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "step_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("story_steps.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column(
            "trigger_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_triggers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("pause_before_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pause_after_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("override_text", sa.Text(), nullable=True),
        sa.Column("override_duration_ms", sa.Integer(), nullable=True),
        sa.UniqueConstraint("step_id", "sort_order", name="uq_story_cues_step_sort"),
    )
    op.create_index(
        "ix_story_narration_cues_step_id", "story_narration_cues", ["step_id"]
    )

    # 6. story_transitions.
    op.create_table(
        "story_transitions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "story_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "from_step_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("story_steps.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "to_step_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("story_steps.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("condition", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint(
            "from_step_id <> to_step_id",
            name="ck_story_transitions_no_self_loop",
        ),
    )
    op.create_index(
        "ix_story_transitions_story_id", "story_transitions", ["story_id"]
    )
    op.create_index(
        "ix_story_transitions_from_step_id",
        "story_transitions",
        ["from_step_id"],
    )
    # Композитный индекс для pick_next: при загрузке исходящих transitions
    # из конкретного шага нам нужно отсортировать по priority DESC.
    op.create_index(
        "ix_story_transitions_from_priority",
        "story_transitions",
        ["from_step_id", sa.text("priority DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_story_transitions_from_priority", table_name="story_transitions")
    op.drop_index("ix_story_transitions_from_step_id", table_name="story_transitions")
    op.drop_index("ix_story_transitions_story_id", table_name="story_transitions")
    op.drop_table("story_transitions")

    op.drop_index("ix_story_narration_cues_step_id", table_name="story_narration_cues")
    op.drop_table("story_narration_cues")

    op.drop_table("story_settings")

    # Сначала убираем FK на entry_step_id, потом сами таблицы.
    op.drop_constraint("fk_stories_entry_step_id", "stories", type_="foreignkey")

    op.drop_index("ix_story_steps_story_id", table_name="story_steps")
    op.drop_table("story_steps")

    op.execute("DROP INDEX IF EXISTS ix_stories_active_slug")
    op.drop_index("ix_stories_slug", table_name="stories")
    op.drop_table("stories")
