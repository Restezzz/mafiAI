from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict


class NightActionRequest(BaseModel):
    """Тело запроса POST /sessions/{id}/night-action (#18).

    target_player_id парсится в UUID на этапе валидации Pydantic'ом.
    Невалидный UUID или отсутствующее поле -> 400 validation_error
    через RequestValidationError handler.
    """
    model_config = ConfigDict(extra="forbid")

    target_player_id: uuid.UUID


class VoteRequest(BaseModel):
    """Тело запроса POST /sessions/{id}/vote (#18).

    target_player_id опционален — null означает воздержался.
    """
    model_config = ConfigDict(extra="forbid")

    target_player_id: uuid.UUID | None = None


class StoryVoteRequest(BaseModel):
    """Тело запроса POST /sessions/{id}/story-vote (Фича 3)."""
    model_config = ConfigDict(extra="forbid")

    story_id: uuid.UUID

