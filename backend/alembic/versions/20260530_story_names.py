"""per-story names: story_names table + rebind story_name_variant_assets

Фича «имена пер-сюжет»:
- Новая таблица ``story_names`` — собственный набор имён сюжета (id, story_id,
  key, display_name, base_audio_file_id, sort_order).
- ``story_name_variant_assets`` перепривязывается с глобального каталога
  ``narrator_name_assets`` на ``story_names``: столбец ``name_asset_id`` →
  ``story_name_id``.

Перепривязка follow-up к недавно смерженной фиче — продовых данных в
``story_name_variant_assets`` нет, поэтому существующие связки очищаются
(а не бэкфилятся).

Revision ID: 20260530_story_names
Revises: 20260529_story_vote_events
Create Date: 2026-05-30
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260530_story_names"
down_revision: Union[str, Sequence[str], None] = "20260529_story_vote_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Набор имён сюжета.
    op.create_table(
        "story_names",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "story_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("stories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(40), nullable=False),
        sa.Column("display_name", sa.String(50), nullable=False),
        sa.Column(
            "base_audio_file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("narrator_audio_files.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
        sa.UniqueConstraint("story_id", "key", name="uq_story_names_story_key"),
    )
    op.create_index("ix_story_names_story_id", "story_names", ["story_id"])

    # 2. Перепривязка story_name_variant_assets → story_names.
    op.execute("DELETE FROM story_name_variant_assets")
    op.drop_constraint(
        "uq_story_name_variant_assets_pair",
        "story_name_variant_assets",
        type_="unique",
    )
    op.drop_index(
        "ix_story_name_variant_assets_name_asset_id",
        table_name="story_name_variant_assets",
    )
    op.drop_column("story_name_variant_assets", "name_asset_id")

    op.add_column(
        "story_name_variant_assets",
        sa.Column("story_name_id", postgresql.UUID(as_uuid=True), nullable=False),
    )
    op.create_foreign_key(
        "fk_story_name_variant_assets_story_name",
        "story_name_variant_assets",
        "story_names",
        ["story_name_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_story_name_variant_assets_story_name_id",
        "story_name_variant_assets",
        ["story_name_id"],
    )
    op.create_unique_constraint(
        "uq_story_name_variant_assets_pair",
        "story_name_variant_assets",
        ["variant_id", "story_name_id"],
    )


def downgrade() -> None:
    op.execute("DELETE FROM story_name_variant_assets")
    op.drop_constraint(
        "uq_story_name_variant_assets_pair",
        "story_name_variant_assets",
        type_="unique",
    )
    op.drop_index(
        "ix_story_name_variant_assets_story_name_id",
        table_name="story_name_variant_assets",
    )
    op.drop_constraint(
        "fk_story_name_variant_assets_story_name",
        "story_name_variant_assets",
        type_="foreignkey",
    )
    op.drop_column("story_name_variant_assets", "story_name_id")

    op.add_column(
        "story_name_variant_assets",
        sa.Column("name_asset_id", postgresql.UUID(as_uuid=True), nullable=False),
    )
    op.create_foreign_key(
        "story_name_variant_assets_name_asset_id_fkey",
        "story_name_variant_assets",
        "narrator_name_assets",
        ["name_asset_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_story_name_variant_assets_name_asset_id",
        "story_name_variant_assets",
        ["name_asset_id"],
    )
    op.create_unique_constraint(
        "uq_story_name_variant_assets_pair",
        "story_name_variant_assets",
        ["variant_id", "name_asset_id"],
    )

    op.drop_index("ix_story_names_story_id", table_name="story_names")
    op.drop_table("story_names")
