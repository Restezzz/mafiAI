"""Add description columns to story_role_overrides and story_names.

Task 1: per-story role description override (StoryRoleOverride.description) —
lets admins change the default role description shown on role_reveal.
Task 2: per-name description (StoryName.description) — shown under each name
on the name_pick screen.

Both nullable Text; NULL falls back to the static catalog / no description.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260602_descriptions"
down_revision: Union[str, Sequence[str], None] = "20260601_drop_pause_kind"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "story_role_overrides",
        sa.Column("description", sa.Text(), nullable=True),
    )
    op.add_column(
        "story_names",
        sa.Column("description", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("story_names", "description")
    op.drop_column("story_role_overrides", "description")
