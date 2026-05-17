"""unique partial index for role_acknowledged events

Защита от race condition в acknowledge_role: между select-проверкой и insert
другой запрос мог вставить дубликат. Partial unique index делает вторую вставку
невозможной на уровне БД (IntegrityError ловится в коде).

Revision ID: 20260516_unique_role_ack
Revises: 20260505_player_renamed
Create Date: 2026-05-16
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "20260516_unique_role_ack"
down_revision: Union[str, Sequence[str], None] = "20260505_player_renamed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


INDEX_NAME = "uq_role_ack_session_phase_player"


def upgrade() -> None:
    # Partial unique index по выражению (payload->>'player_id') только для
    # event_type='role_acknowledged'. Postgres не позволяет UNIQUE-constraint
    # с WHERE в конструкторе, поэтому именно индекс.
    op.execute(
        f"""
        CREATE UNIQUE INDEX IF NOT EXISTS {INDEX_NAME}
        ON game_events (session_id, phase_id, ((payload->>'player_id')))
        WHERE event_type = 'role_acknowledged'
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {INDEX_NAME}")
