"""Pydantic-схемы admin narrator endpoint'ов.

Содержат только READ-ONLY shape; create/update DTO добавляются позже в M3/M4
(вместе с CRUD endpoint'ами).
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


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
