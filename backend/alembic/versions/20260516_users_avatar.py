"""users.avatar_url (base64 data URL для аватарки профиля)

Колонка хранит data:image/jpeg;base64,... URL целиком. Это compromise-вариант:
не нужно отдельное object storage, фронт сжимает до ~50КБ перед отправкой.
Для продакшена со значительной аудиторией стоит вынести в S3/MinIO.

Revision ID: 20260516_users_avatar
Revises: 20260516_phase_indexes
Create Date: 2026-05-16
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260516_users_avatar"
down_revision: Union[str, Sequence[str], None] = "20260516_phase_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("avatar_url", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "avatar_url")
