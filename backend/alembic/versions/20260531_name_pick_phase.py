"""name_pick phase: allow name_pick phase_type + name_pick_started event

Часть A («правильный порядок фаз»): после голосования за сюжет добавляется
фаза ``name_pick`` (выбор имени из набора победившего сюжета) перед раздачей
ролей. Требует расширить CHECK-констрейнты:
- ``game_phases.ck_phases_type`` += ``name_pick``.
- ``game_events.ck_game_events_type`` += ``name_pick_started``.

Revision ID: 20260531_name_pick_phase
Revises: 20260530_story_names
Create Date: 2026-05-31
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "20260531_name_pick_phase"
down_revision: Union[str, Sequence[str], None] = "20260530_story_names"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


PHASE_TYPES_NEW = "'role_reveal', 'day', 'night', 'story_vote', 'name_pick'"
PHASE_TYPES_OLD = "'role_reveal', 'day', 'night', 'story_vote'"

EVENT_TYPES_NEW = (
    "'player_joined', 'player_left', 'game_started', "
    "'player_renamed', 'player_kicked', "
    "'role_acknowledged', 'all_acknowledged', 'phase_changed', "
    "'night_action_submitted', 'night_result', 'player_eliminated', "
    "'vote_cast', 'vote_result', 'game_finished', 'session_closed', "
    "'story_vote_started', 'story_vote', 'name_pick_started'"
)

EVENT_TYPES_OLD = (
    "'player_joined', 'player_left', 'game_started', "
    "'player_renamed', 'player_kicked', "
    "'role_acknowledged', 'all_acknowledged', 'phase_changed', "
    "'night_action_submitted', 'night_result', 'player_eliminated', "
    "'vote_cast', 'vote_result', 'game_finished', 'session_closed', "
    "'story_vote_started', 'story_vote'"
)


def upgrade() -> None:
    op.execute("ALTER TABLE game_phases DROP CONSTRAINT IF EXISTS ck_phases_type")
    op.execute(
        "ALTER TABLE game_phases ADD CONSTRAINT ck_phases_type "
        f"CHECK (phase_type IN ({PHASE_TYPES_NEW}))"
    )
    op.execute("ALTER TABLE game_events DROP CONSTRAINT IF EXISTS ck_game_events_type")
    op.execute(
        "ALTER TABLE game_events ADD CONSTRAINT ck_game_events_type "
        f"CHECK (event_type IN ({EVENT_TYPES_NEW}))"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE game_phases DROP CONSTRAINT IF EXISTS ck_phases_type")
    op.execute(
        "ALTER TABLE game_phases ADD CONSTRAINT ck_phases_type "
        f"CHECK (phase_type IN ({PHASE_TYPES_OLD}))"
    )
    op.execute("ALTER TABLE game_events DROP CONSTRAINT IF EXISTS ck_game_events_type")
    op.execute(
        "ALTER TABLE game_events ADD CONSTRAINT ck_game_events_type "
        f"CHECK (event_type IN ({EVENT_TYPES_OLD}))"
    )
