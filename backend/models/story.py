"""Модели Story Engine — редактируемого графа сюжета.

Архитектура (см. backend/docs/story_engine_design.md):
- ``Story`` — корневая запись сюжета.
- ``StorySettings`` — настройки сюжета (1:1, общие параметры).
- ``StoryStep`` — узел графа (kind ∈ narration | role_action | discussion |
  voting | night_resolve | day_resolve | pause | branch | end).
- ``StoryNarrationCue`` — фраза диктора в шаге ``kind='narration'``.
  Ссылается на существующий ``NarratorTrigger`` (но trigger опционален —
  cue может быть text-only через override_text).
- ``StoryTransition`` — ребро графа от ``from_step`` к ``to_step`` с
  опциональным ``condition`` (JSONB) и ``priority`` (наибольший выигрывает).

ID-policy: все таблицы используют UUID primary keys, как и остальные
модели в проекте.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    Numeric,
    String,
    TIMESTAMP,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


if TYPE_CHECKING:
    from models.narrator import NarratorTrigger


# Допустимые виды шагов. Перечислены тут, потому что используется в
# CheckConstraint миграции и в pydantic-схемах. Никаких enum-типов на уровне
# Postgres — простой VARCHAR + CHECK, чтобы не возиться с alembic ALTER TYPE.
STORY_STEP_KINDS = (
    "narration",       # серия narrator-фраз (cues)
    "role_action",     # ход роли (mafia/sheriff/...)
    "discussion",      # дневная дискуссия (таймер)
    "voting",          # дневное голосование
    "night_resolve",   # подсчёт жертв ночи
    "day_resolve",     # резолв голосования + win-check
    "pause",           # фиксированная пауза (seconds в payload)
    "branch",          # no-op, выбор edge по condition
    "end",             # финал игры
)


class Story(Base):
    """Сюжет — корневая запись графа.

    Версионирование (см. design doc §11.2):
    Один «логический» сюжет = серия записей с одним ``slug`` и разными
    ``version``. При правке активного сюжета создаётся новая запись с
    ``version+1``, старая переводится в ``is_active=False`` +
    ``superseded_by_id`` указывает на новую. Старая запись удаляется
    автоматически, когда нет ни одной ``Session`` с ``story_id=old`` в
    статусе ``lobby``/``active``.

    Инвариант «ровно один ``is_active=True`` на ``slug``» обеспечивается
    partial unique index в миграции (в SQLAlchemy DDL выражается
    через ``Index('...', 'slug', unique=True, postgresql_where=...)``).

    ``entry_step_id`` — с какого шага начинается выполнение. Nullable
    потому что при создании Story шагов ещё нет (chicken-and-egg солвится
    через use_alter=True).

    ``is_obsolete`` — редко используемый флаг «сохранить в БД для аудита,
    но не показывать в UI». Дефолт — hard-delete старых версий, флаг
    ставится ручным решением админа.
    """

    __tablename__ = "stories"
    __table_args__ = (
        UniqueConstraint("slug", "version", name="uq_stories_slug_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    slug: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    is_obsolete: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    # Если True — CueListEditor предлагает в dropdown триггеров ТОЛЬКО
    # триггеры со story_id=this_story.id. Если False — добавляются ещё и
    # global (story_id IS NULL). Default=False для обратной совместимости:
    # старые сюжеты продолжают видеть весь global namespace.
    use_only_own_triggers: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    superseded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stories.id", ondelete="SET NULL"),
        nullable=True,
    )
    entry_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("story_steps.id", ondelete="SET NULL", use_alter=True),
        nullable=True,
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

    settings: Mapped["StorySettings | None"] = relationship(
        back_populates="story",
        cascade="all, delete-orphan",
        uselist=False,
    )
    # foreign_keys явно указан, потому что у Story есть FK entry_step_id → story_steps,
    # а у StoryStep есть FK story_id → stories. Без указания — ambiguous.
    steps: Mapped[list["StoryStep"]] = relationship(
        back_populates="story",
        cascade="all, delete-orphan",
        foreign_keys="StoryStep.story_id",
        order_by="StoryStep.created_at",
    )
    transitions: Mapped[list["StoryTransition"]] = relationship(
        back_populates="story",
        cascade="all, delete-orphan",
        order_by="StoryTransition.priority.desc()",
    )
    superseded_by: Mapped["Story | None"] = relationship(
        "Story",
        remote_side="Story.id",
        foreign_keys=[superseded_by_id],
    )


class StorySettings(Base):
    """Общие настройки сюжета — pre-game-defaults и feature-flags.

    1:1 со Story. Хранится в отдельной таблице (а не в Story.settings JSONB),
    потому что значения часто читаются executor'ом по одному, и хочется
    надёжной типизации с CHECK-констрейнтами на decimal-диапазон.

    ``inter_cue_pause_seconds`` — пауза между cues внутри одного narration-step
    (в секундах, до 2 знаков после запятой, например 3.7).
    ``timer_multiplier_default`` — дефолт для session.settings.timer_multiplier,
    лежит в [0.5, 2.0].
    ``word_karaoke_enabled`` — фронт включает per-word подсветку, если true и
    у variant'а есть word_timings.
    """

    __tablename__ = "story_settings"
    __table_args__ = (
        CheckConstraint(
            "inter_cue_pause_seconds >= 0 AND inter_cue_pause_seconds <= 60",
            name="ck_story_settings_inter_cue_range",
        ),
        CheckConstraint(
            "timer_multiplier_default >= 0.5 AND timer_multiplier_default <= 2",
            name="ck_story_settings_multiplier_range",
        ),
    )

    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stories.id", ondelete="CASCADE"),
        primary_key=True,
    )
    inter_cue_pause_seconds: Mapped[float] = mapped_column(
        Numeric(4, 2), nullable=False, server_default="0.00"
    )
    timer_multiplier_default: Mapped[float] = mapped_column(
        Numeric(3, 2), nullable=False, server_default="1.00"
    )
    karaoke_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )

    story: Mapped["Story"] = relationship(back_populates="settings")


class StoryStep(Base):
    """Узел графа.

    ``slug`` уникален в пределах одного сюжета (для удобства seed/import).
    ``payload`` — kind-specific данные (timer_setting, role_slug, seconds, ...).
    ``position_x/_y`` — координаты в визуальном редакторе (этап 4).

    Cascade при удалении шага: cues удаляются (FK CASCADE),
    transitions с from/to=self.id тоже удаляются (FK CASCADE).
    """

    __tablename__ = "story_steps"
    __table_args__ = (
        UniqueConstraint("story_id", "slug", name="uq_story_steps_story_slug"),
        CheckConstraint(
            "kind IN ('narration', 'role_action', 'discussion', 'voting', "
            "'night_resolve', 'day_resolve', 'pause', 'branch', 'end')",
            name="ck_story_steps_kind",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slug: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False, server_default="")
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    position_x: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    position_y: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    story: Mapped["Story"] = relationship(
        back_populates="steps",
        foreign_keys=[story_id],
    )
    cues: Mapped[list["StoryNarrationCue"]] = relationship(
        back_populates="step",
        cascade="all, delete-orphan",
        order_by="StoryNarrationCue.sort_order",
    )
    outgoing_transitions: Mapped[list["StoryTransition"]] = relationship(
        back_populates="from_step",
        foreign_keys="StoryTransition.from_step_id",
        cascade="all, delete-orphan",
        order_by="StoryTransition.priority.desc()",
    )
    incoming_transitions: Mapped[list["StoryTransition"]] = relationship(
        back_populates="to_step",
        foreign_keys="StoryTransition.to_step_id",
    )


class StoryNarrationCue(Base):
    """Фраза диктора внутри шага ``kind='narration'``.

    ``trigger_id`` ссылается на ``NarratorTrigger`` — runtime берёт оттуда
    variants/composite-templates. Nullable потому что cue может быть
    text-only (без аудио) — тогда runtime использует override_text и
    typewriter без mp3.

    ``override_text`` (опц.) — заменяет текст фразы на runtime, не трогая
    сам триггер. Используется когда нужен один и тот же триггер с разными
    текстами в разных местах сюжета.

    ``pause_before_ms`` / ``pause_after_ms`` — фиксированные паузы вокруг
    cue. Применяются ДО умножения на multiplier. Глобальный inter_cue_pause
    из StorySettings прибавляется поверх.
    """

    __tablename__ = "story_narration_cues"
    __table_args__ = (
        UniqueConstraint("step_id", "sort_order", name="uq_story_cues_step_sort"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("story_steps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    trigger_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("narrator_triggers.id", ondelete="SET NULL"),
        nullable=True,
    )
    pause_before_ms: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    pause_after_ms: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    override_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Принудительная длительность отображения cue (в мс). null — берём из
    # narrator_variants.duration_ms или estimate по тексту. Используется
    # для text-only cues (без trigger), или чтобы растянуть/сжать показ.
    override_duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    step: Mapped["StoryStep"] = relationship(back_populates="cues")
    trigger: Mapped["NarratorTrigger | None"] = relationship(foreign_keys=[trigger_id])


class StoryTransition(Base):
    """Ребро графа с условным переходом.

    ``condition`` JSONB structure:
        null                                       - unconditional (catch-all)
        {"type": "role_alive",   "role_slug": "sheriff"}
        {"type": "role_dead",    "role_slug": "sheriff"}
        {"type": "died_role",    "role_slug": "sheriff"}
        {"type": "death_cause",  "value": "vote" | "night"}
        {"type": "winner",       "team": "city" | "mafia" | "maniac" | null}
        {"type": "phase_number", "op": "==" | ">=" | "<=", "value": <int>}
        {"type": "vote_tie"}
        {"type": "step_var",     "key": "<name>", "op": "==", "value": <any>}

    ``priority`` сортирует выбор edge'ов: при выполнении step'а engine берёт
    transitions из БД ORDER BY priority DESC, итерирует и берёт первый
    подошедший. Безусловный (catch-all) edge ставится с priority=0,
    специализированные — выше (например 20).
    """

    __tablename__ = "story_transitions"
    __table_args__ = (
        # Защита от self-loop (бесконечный цикл на одном шаге без exit-условий
        # — иногда полезно, но безопаснее запретить и явно требовать
        # промежуточный pause-step). Если возникнет надобность — снимем.
        CheckConstraint("from_step_id <> to_step_id", name="ck_story_transitions_no_self_loop"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("stories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    from_step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("story_steps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    to_step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("story_steps.id", ondelete="CASCADE"),
        nullable=False,
    )
    condition: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    story: Mapped["Story"] = relationship(back_populates="transitions")
    from_step: Mapped["StoryStep"] = relationship(
        back_populates="outgoing_transitions",
        foreign_keys=[from_step_id],
    )
    to_step: Mapped["StoryStep"] = relationship(
        back_populates="incoming_transitions",
        foreign_keys=[to_step_id],
    )
