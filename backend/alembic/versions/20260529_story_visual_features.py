"""Story Engine visual features: image_files, name variants, role overrides, story cover

Добавляет фундамент для трёх фич:
- Фича 1 (нода имён): ``story_name_variants`` + ``story_name_variant_assets`` +
  ``story_narration_cues.name_variant_key``.
- Фича 2 (нода ролей): ``image_files`` + ``story_role_overrides``.
- Фича 3 (голосование за сюжет): ``stories.cover_image_id`` + ``stories.cover_crop``.

Также расширяет CHECK ``ck_story_steps_kind`` новыми видами нод ``names`` и
``roles`` (синхронно с ``models/story.py:STORY_STEP_KINDS``).

Revision ID: 20260529_story_visual
Revises: 20260527_story_triggers
Create Date: 2026-05-29
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260529_story_visual"
down_revision: Union[str, Sequence[str], None] = "20260527_story_triggers"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Должно совпадать с models/story.py:STORY_STEP_KINDS.
_OLD_KINDS = (
    "narration", "role_action", "discussion", "voting",
    "night_resolve", "day_resolve", "pause", "branch", "end",
)
_NEW_KINDS = _OLD_KINDS + ("names", "roles")


def _kinds_sql(kinds: tuple[str, ...]) -> str:
    return ", ".join(f"'{k}'" for k in kinds)


def upgrade() -> None:
    # 1. image_files — загруженные картинки (как narrator_audio_files).
    op.create_table(
        "image_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("storage_path", sa.String(500), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
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
        "ix_image_files_filename", "image_files", ["filename"], unique=True
    )

    # 2. stories: обложка + crop.
    op.add_column(
        "stories",
        sa.Column(
            "cover_image_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("image_files.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "stories",
        sa.Column(
            "cover_crop",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )

    # 3. story_narration_cues: name_variant_key.
    op.add_column(
        "story_narration_cues",
        sa.Column("name_variant_key", sa.String(40), nullable=True),
    )

    # 4. story_name_variants.
    op.create_table(
        "story_name_variants",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "story_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(40), nullable=False),
        sa.Column("label", sa.String(120), nullable=False, server_default=""),
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
        sa.UniqueConstraint(
            "story_id", "key", name="uq_story_name_variants_story_key"
        ),
    )
    op.create_index(
        "ix_story_name_variants_story_id", "story_name_variants", ["story_id"]
    )

    # 5. story_name_variant_assets.
    op.create_table(
        "story_name_variant_assets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "variant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("story_name_variants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "name_asset_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_name_assets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "audio_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_audio_files.id", ondelete="SET NULL"),
            nullable=True,
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
        sa.UniqueConstraint(
            "variant_id", "name_asset_id", name="uq_story_name_variant_assets_pair"
        ),
    )
    op.create_index(
        "ix_story_name_variant_assets_variant_id",
        "story_name_variant_assets",
        ["variant_id"],
    )
    op.create_index(
        "ix_story_name_variant_assets_name_asset_id",
        "story_name_variant_assets",
        ["name_asset_id"],
    )

    # 6. story_role_overrides.
    op.create_table(
        "story_role_overrides",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "story_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role_slug", sa.String(20), nullable=False),
        sa.Column("display_name", sa.String(50), nullable=True),
        sa.Column(
            "card_front_image_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("image_files.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "card_back_image_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("image_files.id", ondelete="SET NULL"),
            nullable=True,
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
        sa.UniqueConstraint(
            "story_id", "role_slug", name="uq_story_role_overrides_story_role"
        ),
    )
    op.create_index(
        "ix_story_role_overrides_story_id", "story_role_overrides", ["story_id"]
    )

    # 7. Расширяем CHECK ck_story_steps_kind новыми видами нод.
    op.drop_constraint("ck_story_steps_kind", "story_steps", type_="check")
    op.create_check_constraint(
        "ck_story_steps_kind",
        "story_steps",
        f"kind IN ({_kinds_sql(_NEW_KINDS)})",
    )

    # 8. Фича 3: фаза голосования за сюжет. Расширяем CHECK phase_type.
    op.drop_constraint("ck_phases_type", "game_phases", type_="check")
    op.create_check_constraint(
        "ck_phases_type",
        "game_phases",
        "phase_type IN ('role_reveal', 'day', 'night', 'story_vote')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_phases_type", "game_phases", type_="check")
    op.create_check_constraint(
        "ck_phases_type",
        "game_phases",
        "phase_type IN ('role_reveal', 'day', 'night')",
    )

    # Откат CHECK к старому набору (предварительно никаких names/roles нод
    # быть не должно — иначе откат упадёт; это ожидаемо для дева).
    op.drop_constraint("ck_story_steps_kind", "story_steps", type_="check")
    op.create_check_constraint(
        "ck_story_steps_kind",
        "story_steps",
        f"kind IN ({_kinds_sql(_OLD_KINDS)})",
    )

    op.drop_index("ix_story_role_overrides_story_id", table_name="story_role_overrides")
    op.drop_table("story_role_overrides")

    op.drop_index(
        "ix_story_name_variant_assets_name_asset_id",
        table_name="story_name_variant_assets",
    )
    op.drop_index(
        "ix_story_name_variant_assets_variant_id",
        table_name="story_name_variant_assets",
    )
    op.drop_table("story_name_variant_assets")

    op.drop_index(
        "ix_story_name_variants_story_id", table_name="story_name_variants"
    )
    op.drop_table("story_name_variants")

    op.drop_column("story_narration_cues", "name_variant_key")
    op.drop_column("stories", "cover_crop")
    op.drop_column("stories", "cover_image_id")

    op.drop_index("ix_image_files_filename", table_name="image_files")
    op.drop_table("image_files")
