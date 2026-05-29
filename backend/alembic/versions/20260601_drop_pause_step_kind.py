"""Drop 'pause' from story_steps.kind CHECK constraint.

The pause step was an explicit node type in the story graph editor.
Pauses are now built into phases (voting, role turns, discussions, etc.)
via inter_cue_pause_seconds and pause_before_ms / pause_after_ms on cues,
making a separate pause node type unnecessary.

Any existing story_steps rows with kind='pause' are deleted on upgrade
(none exist in production — the pause node was never used in stories).
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "20260601_drop_pause_kind"
down_revision: Union[str, Sequence[str], None] = "20260531_name_pick_phase"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_KINDS = (
    "narration", "role_action", "discussion", "voting",
    "night_resolve", "day_resolve", "pause", "branch", "end",
    "names", "roles",
)

_NEW_KINDS = tuple(k for k in _OLD_KINDS if k != "pause")


def _kinds_sql(kinds: tuple[str, ...]) -> str:
    return ", ".join(f"'{k}'" for k in kinds)


def upgrade() -> None:
    # Delete any orphaned pause steps (none expected in production).
    op.execute("DELETE FROM story_steps WHERE kind = 'pause'")

    # Narrow the CHECK constraint to exclude 'pause'.
    op.drop_constraint("ck_story_steps_kind", "story_steps", type_="check")
    op.create_check_constraint(
        "ck_story_steps_kind",
        "story_steps",
        f"kind IN ({_kinds_sql(_NEW_KINDS)})",
    )


def downgrade() -> None:
    # Restore the CHECK constraint with 'pause' included.
    op.drop_constraint("ck_story_steps_kind", "story_steps", type_="check")
    op.create_check_constraint(
        "ck_story_steps_kind",
        "story_steps",
        f"kind IN ({_kinds_sql(_OLD_KINDS)})",
    )
