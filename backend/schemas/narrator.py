"""Pydantic-схемы admin narrator endpoint'ов.

Содержит:
- ``*Response`` — read-only shape для GET.
- ``*Create`` / ``*Update`` — request body для POST/PUT.
- ``*ListResponse`` — обёртки для коллекций.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


# Slug допускает [a-z0-9_], 1..80 символов. Совпадает с константой в narration_script.py.
_SLUG_RE = re.compile(r"^[a-z0-9_]{1,80}$")
# group_key для UI-секций (intro, night_mafia, finale и т.п.).
_GROUP_KEY_RE = re.compile(r"^[a-z0-9_]{1,50}$")


class AudioFileResponse(BaseModel):
    id: str
    filename: str
    # Публичный URL для воспроизведения через StaticFiles mount.
    # Собирается как /audio/{storage_path}.
    url: str
    duration_ms: int
    size_bytes: int
    uploaded_at: datetime
    uploaded_by_id: str | None = None


class VariantResponse(BaseModel):
    id: str
    audio_file_id: str | None
    audio_url: str | None = Field(default=None, description="Готовый URL mp3 (None если text-only)")
    text: str
    duration_ms: int | None
    sort_order: int


class CompositeSegmentResponse(BaseModel):
    id: str
    position: int
    kind: Literal["audio", "placeholder"]
    audio_file_id: str | None = None
    audio_url: str | None = None
    placeholder_key: str | None = None
    text_fragment: str


class CompositeTemplateResponse(BaseModel):
    id: str
    label: str | None
    sort_order: int
    segments: list[CompositeSegmentResponse]


class TriggerResponse(BaseModel):
    id: str
    slug: str
    # None — global триггер (доступен всем сюжетам). Строковый UUID
    # — триггер привязан к конкретному сюжету (story-scoped).
    story_id: str | None = None
    group_key: str
    label: str
    description: str | None
    kind: Literal["variant", "composite"]
    created_at: datetime
    updated_at: datetime
    variants: list[VariantResponse] = []
    composite_templates: list[CompositeTemplateResponse] = []


class NameAssetResponse(BaseModel):
    id: str
    display_name: str
    slug: str
    gender: Literal["m", "f"]
    audio_file_id: str
    audio_url: str


class PlaceholderInfo(BaseModel):
    """Метаданные о placeholder'е (для UI composite-builder'а).

    Этот каталог захардкожен в backend (services/narrator_placeholders.py),
    потому что добавление нового placeholder'а требует кодовых изменений в
    game_engine (резолвер должен знать откуда брать значение).
    """
    key: str
    label: str
    description: str


class TriggersListResponse(BaseModel):
    triggers: list[TriggerResponse]


class AudioFilesListResponse(BaseModel):
    audio_files: list[AudioFileResponse]


class NameAssetsListResponse(BaseModel):
    name_assets: list[NameAssetResponse]


class PlaceholdersListResponse(BaseModel):
    placeholders: list[PlaceholderInfo]


# ---------------------------------------------------------------------------
# Request bodies (POST / PUT)
# ---------------------------------------------------------------------------


class TriggerCreate(BaseModel):
    """Создание нового триггера. ``kind`` после создания не меняется.

    ``story_id``: None или отсутствует — global триггер (доступен всем сюжетам).
    Строковый UUID — триггер привязан к этому сюжету и удаляется
    каскадно при его удалении.
    """

    slug: str = Field(..., min_length=1, max_length=80)
    story_id: str | None = Field(default=None)
    group_key: str = Field(..., min_length=1, max_length=50)
    label: str = Field(..., min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    kind: Literal["variant", "composite"]

    @field_validator("slug")
    @classmethod
    def _validate_slug(cls, v: str) -> str:
        if not _SLUG_RE.match(v):
            raise ValueError("slug должен быть [a-z0-9_], 1..80 символов")
        return v

    @field_validator("group_key")
    @classmethod
    def _validate_group_key(cls, v: str) -> str:
        if not _GROUP_KEY_RE.match(v):
            raise ValueError("group_key должен быть [a-z0-9_], 1..50 символов")
        return v


class TriggerUpdate(BaseModel):
    """Обновление триггера. Поля ``slug`` и ``kind`` неизменяемы (иначе game_engine
    integration и существующие variants/templates сломаются — придётся пересоздавать).
    """

    group_key: str | None = Field(default=None, min_length=1, max_length=50)
    label: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("group_key")
    @classmethod
    def _validate_group_key(cls, v: str | None) -> str | None:
        if v is not None and not _GROUP_KEY_RE.match(v):
            raise ValueError("group_key должен быть [a-z0-9_], 1..50 символов")
        return v


class VariantCreate(BaseModel):
    """Создание варианта для kind='variant' триггера.

    ``audio_file_id=None`` → text-only вариант (typewriter без mp3).
    ``text`` может содержать ``{placeholder_key}`` для подстановки на runtime.
    """

    audio_file_id: str | None = None
    text: str = Field(..., min_length=1, max_length=4000)
    duration_ms: int | None = Field(default=None, ge=0, le=300_000)
    sort_order: int = Field(default=0, ge=0)


class VariantUpdate(BaseModel):
    audio_file_id: str | None = Field(default=None, description="None в JSON = НЕ менять; чтобы сбросить → audio_file_id='', либо передавать unset_audio=true")
    text: str | None = Field(default=None, min_length=1, max_length=4000)
    duration_ms: int | None = Field(default=None, ge=0, le=300_000)
    sort_order: int | None = Field(default=None, ge=0)
    # Явный флаг сброса аудио → text-only вариант.
    unset_audio: bool = False


class CompositeTemplateCreate(BaseModel):
    label: str | None = Field(default=None, max_length=120)
    sort_order: int = Field(default=0, ge=0)


class CompositeTemplateUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=120)
    sort_order: int | None = Field(default=None, ge=0)


class CompositeSegmentCreate(BaseModel):
    """Сегмент composite-template.

    Инварианты (проверяются в endpoint'е):
    - ``kind='audio'`` → ``audio_file_id`` обязателен, ``placeholder_key`` должен быть None.
    - ``kind='placeholder'`` → ``placeholder_key`` обязателен (из catalog),
      ``audio_file_id`` должен быть None.
    """

    position: int = Field(..., ge=0)
    kind: Literal["audio", "placeholder"]
    audio_file_id: str | None = None
    placeholder_key: str | None = Field(default=None, max_length=60)
    text_fragment: str = Field(default="", max_length=4000)


class CompositeSegmentUpdate(BaseModel):
    """PATCH-style: только переданные поля изменяются.

    Не меняйте ``kind`` без сброса соответствующих полей —  endpoint валидирует
    финальную консистентность после применения апдейта.
    """

    position: int | None = Field(default=None, ge=0)
    kind: Literal["audio", "placeholder"] | None = None
    audio_file_id: str | None = None
    placeholder_key: str | None = Field(default=None, max_length=60)
    text_fragment: str | None = Field(default=None, max_length=4000)
    unset_audio: bool = False


class NameAssetUpdate(BaseModel):
    """Обновление имени-актива. ``slug`` пересчитывается, если меняется display_name."""

    display_name: str | None = Field(default=None, min_length=1, max_length=60)
    gender: Literal["m", "f"] | None = None
    audio_file_id: str | None = Field(
        default=None,
        description="UUID существующего NarratorAudioFile. Полностью переиспользует mp3.",
    )
