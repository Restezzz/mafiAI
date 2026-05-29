"""allow story_vote and player_kicked game events

Revision ID: 20260529_story_vote_events
Revises: 20260529_story_visual
Create Date: 2026-05-29
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "20260529_story_vote_events"
down_revision: Union[str, Sequence[str], None] = "20260529_story_visual"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


EVENT_TYPES_NEW = (
    "'player_joined', 'player_left', 'game_started', "
    "'player_renamed', 'player_kicked', "
    "'role_acknowledged', 'all_acknowledged', 'phase_changed', "
    "'night_action_submitted', 'night_result', 'player_eliminated', "
    "'vote_cast', 'vote_result', 'game_finished', 'session_closed', "
    "'story_vote_started', 'story_vote'"
)

EVENT_TYPES_OLD = (
    "'player_joined', 'player_left', 'game_started', "
    "'player_renamed', "
    "'role_acknowledged', 'all_acknowledged', 'phase_changed', "
    "'night_action_submitted', 'night_result', 'player_eliminated', "
    "'vote_cast', 'vote_result', 'game_finished', 'session_closed'"
)


def upgrade() -> None:
    op.execute("ALTER TABLE game_events DROP CONSTRAINT IF EXISTS ck_game_events_type")
    op.execute(
        "ALTER TABLE game_events ADD CONSTRAINT ck_game_events_type "
        f"CHECK (event_type IN ({EVENT_TYPES_NEW}))"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE game_events DROP CONSTRAINT IF EXISTS ck_game_events_type")
    op.execute(
        "ALTER TABLE game_events ADD CONSTRAINT ck_game_events_type "
        f"CHECK (event_type IN ({EVENT_TYPES_OLD}))"
    )
