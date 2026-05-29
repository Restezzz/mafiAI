"""Модели админ-системы фраз ведущего (narrator).

Архитектура:
- ``NarratorAudioFile`` — физический mp3 (хранится в settings.AUDIO_STORAGE_ROOT).
- ``NarratorTrigger`` — точка вызова в game_engine ('mafia_exit_poem', 'one_killed' и т.д.).
  Имеет ``kind``:
    * 'variant' — N альтернативных вариантов (текст + опц. mp3),
      runtime выбирает один по hash(seed) % N.
    * 'composite' — N альтернативных шаблонов, каждый — последовательность
      сегментов (audio + placeholder), позволяющая вставлять динамические
      mp3 (например имя игрока) в середину фразы.
- ``NarratorVariant`` — один вариант для kind='variant'.
- ``NarratorCompositeTemplate`` + ``NarratorCompositeSegment`` — структура composite-фразы.
- ``NarratorNameAsset`` — аудио-имена игроков, разворачиваются в placeholder='player_name'.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    TIMESTAMP,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base

if TYPE_CHECKING:
    from models.user import User


class NarratorAudioFile(Base):
    """MP3-файл озвучки. Физически лежит в ``settings.AUDIO_STORAGE_ROOT/storage_path``.

    URL для отдачи клиенту собирается как ``/audio/{storage_path}`` (StaticFiles mount).
    """
    __tablename__ = "narrator_audio_files"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    filename: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    # Относительно AUDIO_STORAGE_ROOT, например 'mafia/exit_poem_001.mp3'.
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )

    uploaded_by: Mapped["User | None"] = relationship(foreign_keys=[uploaded_by_id])


class NarratorTrigger(Base):
    """Триггер фразы ведущего. ``slug`` совпадает с action_key из game_engine.

    ``group_key`` нужен для UI-группировки в админке (например 'night_mafia',
    'finale'). ``label``/``description`` — человекочитаемые подписи.

    ``story_id`` (этап 6.6): если NULL — триггер глобальный, доступен всем
    сюжетам. Если выставлен — триггер привязан к конкретному сюжету и
    автоматически удаляется при его удалении (CASCADE). Slug-уникальность
    обеспечена двумя partial unique indexes (см. миграцию
    20260527_story_scoped_triggers): один global slug, либо уникальный
    (story_id, slug) per-story.
    """
    __tablename__ = "narrator_triggers"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('variant', 'composite')",
            name="ck_narrator_triggers_kind",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # ВНИМАНИЕ: НЕ unique=True. Уникальность обеспечена partial-индексами
    # в миграции (global slug + per-story slug). Здесь только обычный index.
    slug: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    story_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stories.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    group_key: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    variants: Mapped[list["NarratorVariant"]] = relationship(
        back_populates="trigger",
        cascade="all, delete-orphan",
        order_by="NarratorVariant.sort_order",
    )
    composite_templates: Mapped[list["NarratorCompositeTemplate"]] = relationship(
        back_populates="trigger",
        cascade="all, delete-orphan",
        order_by="NarratorCompositeTemplate.sort_order",
    )


class NarratorVariant(Base):
    """Вариант фразы для триггера kind='variant'.

    Если ``audio_file_id`` is None — играется только typewriter-текст (fallback
    режим без озвучки). Если есть mp3 — клиент проигрывает аудио + параллельно
    typewriter синхронизируется по ``duration_ms``.
    """
    __tablename__ = "narrator_variants"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    trigger_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("narrator_triggers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    audio_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("narrator_audio_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # Длительность для тайминга typewriter'а. Если есть audio — синхронизирована
    # с реальной длительностью mp3, иначе — оценка по estimate_duration_ms.
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    trigger: Mapped["NarratorTrigger"] = relationship(back_populates="variants")
    audio_file: Mapped["NarratorAudioFile | None"] = relationship(foreign_keys=[audio_file_id])


class NarratorCompositeTemplate(Base):
    """Шаблон composite-фразы — последовательность сегментов.

    У одного триггера может быть несколько templates (например 8 разных
    intro-фраз для 'one_killed'), runtime выбирает один по hash(seed) %
    len(templates), а уже внутри template сегменты воспроизводятся по
    порядку с подстановкой placeholder'ов.
    """
    __tablename__ = "narrator_composite_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    trigger_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("narrator_triggers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    trigger: Mapped["NarratorTrigger"] = relationship(back_populates="composite_templates")
    segments: Mapped[list["NarratorCompositeSegment"]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        order_by="NarratorCompositeSegment.position",
    )


class NarratorCompositeSegment(Base):
    """Один сегмент composite-template.

    kind='audio': статический mp3-кусок (например opener "Сегодня погиб игрок").
    kind='placeholder': динамическая вставка (например 'player_name'). На runtime
    placeholder резолвится через ``narrator_repo``: 'player_name' -> ищется
    ``NarratorNameAsset.audio_file`` по display_name умершего игрока.

    ``text_fragment`` — текст для typewriter'а (для placeholder обычно пустой,
    runtime подставляет значение в полный текст шага).
    """
    __tablename__ = "narrator_composite_segments"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('audio', 'placeholder')",
            name="ck_narrator_segments_kind",
        ),
        UniqueConstraint("template_id", "position", name="uq_narrator_segments_template_pos"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("narrator_composite_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    audio_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("narrator_audio_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    placeholder_key: Mapped[str | None] = mapped_column(String(60), nullable=True)
    text_fragment: Mapped[str] = mapped_column(Text, nullable=False, server_default="")

    template: Mapped["NarratorCompositeTemplate"] = relationship(back_populates="segments")
    audio_file: Mapped["NarratorAudioFile | None"] = relationship(foreign_keys=[audio_file_id])


class NarratorNameAsset(Base):
    """Аудио-имя игрока (для placeholder='player_name' в composite-фразах).

    При резолве composite-сегмента kind='placeholder' с placeholder_key='player_name'
    runtime ищет запись по ``display_name`` (или fallback по slug-у) умершего/изгнанного
    игрока и подставляет ``audio_file`` в audio_segments.
    """
    __tablename__ = "narrator_name_assets"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    display_name: Mapped[str] = mapped_column(String(60), unique=True, nullable=False, index=True)
    slug: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    gender: Mapped[str] = mapped_column(String(1), nullable=False)
    audio_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("narrator_audio_files.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    audio_file: Mapped["NarratorAudioFile"] = relationship(foreign_keys=[audio_file_id])
