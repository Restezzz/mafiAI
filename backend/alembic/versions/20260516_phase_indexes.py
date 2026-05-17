"""composite index for fast get_current_phase and event lookups

#19/#24: get_current_phase делает WHERE session_id=? AND ended_at IS NULL ORDER BY started_at DESC.
Без индекса Postgres делает seq scan по game_phases. Composite-индекс ускоряет до O(log N).
Также добавлен индекс для частых запросов к game_events по (session_id, phase_id, event_type).

Revision ID: 20260516_phase_indexes
Revises: 20260516_unique_role_ack
Create Date: 2026-05-16
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "20260516_phase_indexes"
down_revision: Union[str, Sequence[str], None] = "20260516_unique_role_ack"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


PHASES_INDEX = "ix_game_phases_session_active"
EVENTS_INDEX = "ix_game_events_session_phase_type"


def upgrade() -> None:
    # Активная фаза сессии: WHERE session_id=? AND ended_at IS NULL.
    # Partial index по ended_at IS NULL даёт минимальный размер (только активные)
    # и optimal для частого ORDER BY started_at DESC LIMIT 1.
    op.execute(
        f"""
        CREATE INDEX IF NOT EXISTS {PHASES_INDEX}
        ON game_phases (session_id, started_at DESC)
        WHERE ended_at IS NULL
        """
    )
    # COUNT(role_acknowledged) и lookup'ы по (session, phase, event_type) — частый паттерн
    # в /state и acknowledge_role. Btree index на трёх колонках покрывает оба варианта.
    op.execute(
        f"""
        CREATE INDEX IF NOT EXISTS {EVENTS_INDEX}
        ON game_events (session_id, phase_id, event_type)
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {EVENTS_INDEX}")
    op.execute(f"DROP INDEX IF EXISTS {PHASES_INDEX}")
