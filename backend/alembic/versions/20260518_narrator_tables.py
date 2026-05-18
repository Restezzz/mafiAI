"""narrator system: triggers, variants, composite templates/segments, audio files, name assets

Создаёт фундамент для админ-панели редактирования фраз ведущего:
- narrator_audio_files — физические mp3 (хранятся в settings.AUDIO_STORAGE_ROOT).
- narrator_triggers — точки вызова из game_engine ('mafia_exit_poem', 'one_killed', ...).
- narrator_variants — N альтернативных вариантов для триггеров kind='variant'.
- narrator_composite_templates + narrator_composite_segments — composite-фразы
  с placeholder'ами для динамической вставки имени/роли в середину mp3-склейки.
- narrator_name_assets — аудио-имена игроков для placeholder='player_name'.

Само наполнение БД (миграция existing хардкода) делается отдельным
скриптом scripts/migrate_narrator_to_db.py — эта alembic-миграция только
создаёт пустые таблицы.

Revision ID: 20260518_narrator_tables
Revises: 20260516_refresh_revoked
Create Date: 2026-05-18
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260518_narrator_tables"
down_revision: Union[str, Sequence[str], None] = "20260516_refresh_revoked"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "narrator_audio_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("filename", sa.String(255), nullable=False, unique=True),
        sa.Column("storage_path", sa.String(500), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column(
            "uploaded_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "uploaded_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_narrator_audio_files_filename",
        "narrator_audio_files",
        ["filename"],
    )

    op.create_table(
        "narrator_triggers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(80), nullable=False, unique=True),
        sa.Column("group_key", sa.String(50), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("kind", sa.String(20), nullable=False),
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
        sa.CheckConstraint(
            "kind IN ('variant', 'composite')",
            name="ck_narrator_triggers_kind",
        ),
    )
    op.create_index("ix_narrator_triggers_slug", "narrator_triggers", ["slug"])
    op.create_index("ix_narrator_triggers_group_key", "narrator_triggers", ["group_key"])

    op.create_table(
        "narrator_variants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "trigger_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_triggers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "audio_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_audio_files.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
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
    )
    op.create_index("ix_narrator_variants_trigger", "narrator_variants", ["trigger_id"])

    op.create_table(
        "narrator_composite_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "trigger_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_triggers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("label", sa.String(120), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
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
    )
    op.create_index(
        "ix_narrator_composite_templates_trigger",
        "narrator_composite_templates",
        ["trigger_id"],
    )

    op.create_table(
        "narrator_composite_segments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "template_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_composite_templates.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column(
            "audio_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_audio_files.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("placeholder_key", sa.String(60), nullable=True),
        sa.Column("text_fragment", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint(
            "kind IN ('audio', 'placeholder')",
            name="ck_narrator_segments_kind",
        ),
        sa.UniqueConstraint(
            "template_id", "position",
            name="uq_narrator_segments_template_pos",
        ),
    )
    op.create_index(
        "ix_narrator_segments_template",
        "narrator_composite_segments",
        ["template_id"],
    )

    op.create_table(
        "narrator_name_assets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("display_name", sa.String(60), nullable=False, unique=True),
        sa.Column("slug", sa.String(60), nullable=False, unique=True),
        sa.Column("gender", sa.String(1), nullable=False),
        sa.Column(
            "audio_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_audio_files.id", ondelete="RESTRICT"),
            nullable=False,
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
    )
    op.create_index(
        "ix_narrator_name_assets_display_name",
        "narrator_name_assets",
        ["display_name"],
    )


def downgrade() -> None:
    op.drop_index("ix_narrator_name_assets_display_name", table_name="narrator_name_assets")
    op.drop_table("narrator_name_assets")

    op.drop_index("ix_narrator_segments_template", table_name="narrator_composite_segments")
    op.drop_table("narrator_composite_segments")

    op.drop_index(
        "ix_narrator_composite_templates_trigger",
        table_name="narrator_composite_templates",
    )
    op.drop_table("narrator_composite_templates")

    op.drop_index("ix_narrator_variants_trigger", table_name="narrator_variants")
    op.drop_table("narrator_variants")

    op.drop_index("ix_narrator_triggers_group_key", table_name="narrator_triggers")
    op.drop_index("ix_narrator_triggers_slug", table_name="narrator_triggers")
    op.drop_table("narrator_triggers")

    op.drop_index("ix_narrator_audio_files_filename", table_name="narrator_audio_files")
    op.drop_table("narrator_audio_files")
