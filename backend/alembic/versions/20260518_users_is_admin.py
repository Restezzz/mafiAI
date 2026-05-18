"""users.is_admin flag for narrator admin panel access

Adds boolean column users.is_admin (default false). Required for the
require_admin FastAPI dependency that gates the narrator admin endpoints.
Promotion is done manually via SQL or a CLI script — there is no
self-service endpoint for granting admin rights.

Revision ID: 20260518_users_is_admin
Revises: 20260518_narrator_tables
Create Date: 2026-05-18
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260518_users_is_admin"
down_revision: Union[str, Sequence[str], None] = "20260518_narrator_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "is_admin",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "is_admin")
