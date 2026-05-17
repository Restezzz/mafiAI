from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from schemas.validators import strip_name_value
from schemas.dev import DevLobbyInfo
from services.audio_manifest import get_manifest as get_audio_manifest


def _validate_voiced_name_strict(v: str | None) -> str | None:
    """Строгая валидация: имя обязано быть из списка озвученных имён.

    Используется при финальном выборе имени (rename после сюжета), где
    озвучка обязана найти аудио для имени.
    """
    cleaned = strip_name_value(v)
    allowed = get_audio_manifest().display_names()
    if not allowed:
        return cleaned
    if cleaned is None or cleaned == "":
        raise ValueError(
            "Нужно выбрать имя персонажа: " + ", ".join(allowed)
        )
    if cleaned not in allowed:
        raise ValueError(
            f"Имя должно быть из списка персонажей: {', '.join(allowed)}"
        )
    return cleaned


def _strip_optional_name(v: str | None) -> str | None:
    """Мягкая валидация: просто strip и отдаём. Backend подставит nickname как
    плейсхолдер при пустом значении. Финальное имя игрок выберет на этапе
    выбора сюжета (см. RenamePlayerRequest).
    """
    return strip_name_value(v)


class RoleConfig(BaseModel):
    mafia: int = Field(ge=0)
    sheriff: int = Field(default=0, ge=0, le=1)
    doctor: int = Field(default=0, ge=0, le=1)
    don: int = Field(default=0, ge=0, le=1)
    lover: int = Field(default=0, ge=0, le=1)
    maniac: int = Field(default=0, ge=0, le=1)


class SessionSettings(BaseModel):
    role_reveal_timer_seconds: int = Field(default=15, ge=10, le=30)
    discussion_timer_seconds: int = Field(default=120, ge=30, le=300)
    voting_timer_seconds: int = Field(default=60, ge=15, le=120)
    night_action_timer_seconds: int = Field(default=30, ge=15, le=60)
    role_config: RoleConfig


class CreateSessionRequest(BaseModel):
    player_count: int = Field(ge=5, le=20)
    settings: SessionSettings
    host_name: str | None = Field(default=None, max_length=32)

    @field_validator("host_name")
    @classmethod
    def strip_host_name(cls, v: str | None) -> str | None:
        return _strip_optional_name(v)


class SessionResponse(BaseModel):
    id: str
    code: str
    host_user_id: str
    player_count: int
    status: str
    settings: dict
    created_at: str


class PlayerInList(BaseModel):
    id: str
    name: str
    # Никнейм аккаунта (User.display_name) — фронт показывает второй строкой
    # под именем персонажа в лобби и игровых меню. Optional для совместимости
    # со старыми клиентами и для путей, где user не подгружен.
    username: str | None = None
    join_order: int
    is_host: bool
    is_me: bool = False


class SessionDetailResponse(BaseModel):
    id: str
    code: str
    host_user_id: str
    player_count: int
    status: str
    settings: dict
    players: list[PlayerInList]
    created_at: str
    dev_lobby: DevLobbyInfo | None = None


class JoinRequest(BaseModel):
    """Имя игрока — опциональный плейсхолдер; финальное озвученное имя
    выбирается на странице выбора сюжета (см. RenamePlayerRequest)."""

    name: str | None = Field(default=None, max_length=32)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str | None) -> str | None:
        return _strip_optional_name(v)


class JoinResponse(BaseModel):
    player_id: str
    session_id: str
    join_order: int


class RenamePlayerRequest(BaseModel):
    """Финальный выбор имени персонажа (после выбора сюжета).

    Имя обязано быть из списка озвученных имён в audio_manifest и уникально
    среди всех игроков сессии (проверка уникальности — на уровне роутера).
    """

    name: str = Field(max_length=32)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        cleaned = _validate_voiced_name_strict(v)
        if not cleaned:
            raise ValueError("Имя обязательно")
        return cleaned


class AudioPreloadReadyRequest(BaseModel):
    manifest_version: str


class UpdateSettingsRequest(BaseModel):
    role_reveal_timer_seconds: int | None = Field(default=None, ge=10, le=30)
    discussion_timer_seconds: int | None = Field(default=None, ge=30, le=300)
    voting_timer_seconds: int | None = Field(default=None, ge=15, le=120)
    night_action_timer_seconds: int | None = Field(default=None, ge=15, le=60)
    role_config: RoleConfig | None = None
