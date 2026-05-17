"""refresh_tokens.revoked_at (soft-revoke + reuse detection)

Раньше использованный refresh-токен просто удалялся; теперь он остаётся
с пометкой `revoked_at`. Это нужно, чтобы:
1. Отличать «нет токена» от «токен уже использовали» — second flag = угон.
2. Правомочно отзывать всю цепочку refresh-токенов пользователя при reuse.

Revision ID: 20260516_refresh_revoked
Revises: 20260516_users_avatar
Create Date: 2026-05-16
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260516_refresh_revoked"
down_revision: Union[str, Sequence[str], None] = "20260516_users_avatar"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_refresh_tokens_user_active",
        "refresh_tokens",
        ["user_id"],
        postgresql_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_user_active", table_name="refresh_tokens")
    op.drop_column("refresh_tokens", "revoked_at")
