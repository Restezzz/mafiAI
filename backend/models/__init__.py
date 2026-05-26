"""Регистрация ORM-моделей (нужно для Alembic autogenerate)."""

from models.user import User
from models.session import Session
from models.player import Player
from models.role import Role
from models.game_phase import GamePhase
from models.night_action import NightAction
from models.day_vote import DayVote
from models.game_event import GameEvent
from models.subscription import Subscription
from models.payment import Payment
from models.refresh_token import RefreshToken
from models.dev_test_lobby_link import DevTestLobbyLink
from models.narrator import (
    NarratorAudioFile,
    NarratorTrigger,
    NarratorVariant,
    NarratorCompositeTemplate,
    NarratorCompositeSegment,
    NarratorNameAsset,
)
from models.story import (
    Story,
    StorySettings,
    StoryStep,
    StoryNarrationCue,
    StoryTransition,
)

__all__ = [
    "User",
    "Session",
    "Player",
    "Role",
    "GamePhase",
    "NightAction",
    "DayVote",
    "GameEvent",
    "Subscription",
    "Payment",
    "RefreshToken",
    "DevTestLobbyLink",
    "NarratorAudioFile",
    "NarratorTrigger",
    "NarratorVariant",
    "NarratorCompositeTemplate",
    "NarratorCompositeSegment",
    "NarratorNameAsset",
    "Story",
    "StorySettings",
    "StoryStep",
    "StoryNarrationCue",
    "StoryTransition",
]
