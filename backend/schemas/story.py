"""Pydantic-схемы Story Engine — admin API + import/export.

Содержит:
- ``Condition*`` — рекурсивная схема условий transition (атомарные предикаты
  + композитные комбинаторы all/any/not, см. design doc §3.4).
- ``StorySettings*`` — настройки сюжета (read/update).
- ``StoryNarrationCue*`` — фразы внутри narration-step.
- ``StoryStep*`` — узлы графа.
- ``StoryTransition*`` — рёбра графа.
- ``Story*`` — корневой сюжет (ListItem / ReadFull / Create / Update).
- ``StoryReorder*`` — bulk reorder cues.
- ``StoryExport`` / ``StoryImport`` — JSON-сериализация всего графа для
  бекапа/переноса между окружениями (этап 1).

Поля ``id`` сериализуются как str (UUID → str). На входе принимаем UUID
(pydantic автоматически парсит из строки).
"""
from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from models.story import STORY_STEP_KINDS


# Разрешённые слаги: [a-z0-9_], 1..80 символов. Совпадает с CHECK на уровне БД
# для slug-полей story / story_steps.
_SLUG_RE = re.compile(r"^[a-z0-9_]{1,80}$")


# =============================================================================
# Condition expressions (рекурсивные)
# =============================================================================
#
# Структура:
#   Condition = AtomicCondition | CompositeCondition
#   AtomicCondition: {type: <one of 8 atomic types>, ...params}
#   CompositeCondition: {type: 'all' | 'any', conditions: list[Condition]}
#                     | {type: 'not', condition: Condition}
#
# Discriminated union с рекурсивными forward-references. Pydantic v2 нативно
# поддерживает: используем Annotated[Union[...], Field(discriminator='type')]
# и model_rebuild() в конце файла.


class _ConditionBase(BaseModel):
    """База: запрещаем лишние поля чтобы валидация условий была строгая."""

    model_config = ConfigDict(extra="forbid")


class RoleAliveCondition(_ConditionBase):
    type: Literal["role_alive"]
    role_slug: str = Field(..., min_length=1, max_length=80)


class RoleDeadCondition(_ConditionBase):
    type: Literal["role_dead"]
    role_slug: str = Field(..., min_length=1, max_length=80)


class DiedRoleCondition(_ConditionBase):
    type: Literal["died_role"]
    role_slug: str = Field(..., min_length=1, max_length=80)


class DeathCauseCondition(_ConditionBase):
    type: Literal["death_cause"]
    value: Literal["vote", "night"]


class WinnerCondition(_ConditionBase):
    type: Literal["winner"]
    # null = «победитель определён, но team-нейтральный» (теоретически — например
    # ничья). Для конкретных команд: city / mafia / maniac.
    team: Literal["city", "mafia", "maniac"] | None = None


class PhaseNumberCondition(_ConditionBase):
    type: Literal["phase_number"]
    op: Literal["==", "!=", ">=", "<=", ">", "<"]
    value: int = Field(..., ge=0, le=1000)


class VoteTieCondition(_ConditionBase):
    type: Literal["vote_tie"]


class StepVarCondition(_ConditionBase):
    type: Literal["step_var"]
    key: str = Field(..., min_length=1, max_length=80)
    op: Literal["==", "!=", ">=", "<=", ">", "<"]
    value: Any  # int / str / bool / null — eval-логика в executor'е


class AllCondition(_ConditionBase):
    type: Literal["all"]
    conditions: list["Condition"] = Field(..., min_length=1, max_length=20)


class AnyCondition(_ConditionBase):
    type: Literal["any"]
    conditions: list["Condition"] = Field(..., min_length=1, max_length=20)


class NotCondition(_ConditionBase):
    type: Literal["not"]
    condition: "Condition"


# Discriminated union по полю `type`. Pydantic эффективно резолвит дискриминатор
# без перебора всех вариантов.
Condition = Annotated[
    Union[
        RoleAliveCondition,
        RoleDeadCondition,
        DiedRoleCondition,
        DeathCauseCondition,
        WinnerCondition,
        PhaseNumberCondition,
        VoteTieCondition,
        StepVarCondition,
        AllCondition,
        AnyCondition,
        NotCondition,
    ],
    Field(discriminator="type"),
]


# =============================================================================
# StorySettings
# =============================================================================


class StorySettingsRead(BaseModel):
    inter_cue_pause_seconds: Decimal
    timer_multiplier_default: Decimal
    karaoke_enabled: bool


class StorySettingsUpdate(BaseModel):
    """PATCH-style: незаданные поля не меняются."""

    inter_cue_pause_seconds: Decimal | None = Field(
        default=None, ge=Decimal("0"), le=Decimal("60")
    )
    timer_multiplier_default: Decimal | None = Field(
        default=None, ge=Decimal("0.5"), le=Decimal("2")
    )
    karaoke_enabled: bool | None = None


# =============================================================================
# StoryNarrationCue
# =============================================================================


class StoryNarrationCueRead(BaseModel):
    id: str
    sort_order: int
    trigger_id: str | None
    # Резолвленные данные триггера (slug, label) для удобства UI — берётся
    # из relationship.trigger при сериализации в endpoint'е.
    trigger_slug: str | None = None
    pause_before_ms: int
    pause_after_ms: int
    override_text: str | None
    override_duration_ms: int | None


class StoryNarrationCueCreate(BaseModel):
    sort_order: int = Field(..., ge=0, le=9999)
    trigger_id: UUID | None = None
    pause_before_ms: int = Field(default=0, ge=0, le=60_000)
    pause_after_ms: int = Field(default=0, ge=0, le=60_000)
    override_text: str | None = Field(default=None, max_length=4000)
    override_duration_ms: int | None = Field(default=None, ge=0, le=300_000)

    @model_validator(mode="after")
    def _ensure_trigger_or_text(self) -> "StoryNarrationCueCreate":
        # Cue должна иметь хотя бы что-то для отображения: либо trigger, либо
        # override_text (для text-only фразы без аудио).
        if self.trigger_id is None and not self.override_text:
            raise ValueError(
                "cue должна иметь либо trigger_id (ссылку на narrator_triggers), "
                "либо override_text (для text-only без аудио)"
            )
        return self


class StoryNarrationCueUpdate(BaseModel):
    """PATCH: незаданные поля не меняются. Чтобы сбросить trigger_id → ``unset_trigger=True``."""

    sort_order: int | None = Field(default=None, ge=0, le=9999)
    trigger_id: UUID | None = None
    unset_trigger: bool = False
    pause_before_ms: int | None = Field(default=None, ge=0, le=60_000)
    pause_after_ms: int | None = Field(default=None, ge=0, le=60_000)
    override_text: str | None = Field(default=None, max_length=4000)
    override_duration_ms: int | None = Field(default=None, ge=0, le=300_000)


class StoryLayoutItem(BaseModel):
    """Одна позиция ноды в bulk-апдейте layout (этап 4 — node editor)."""

    step_id: UUID
    position_x: int = Field(..., ge=-100_000, le=100_000)
    position_y: int = Field(..., ge=-100_000, le=100_000)


class StoryLayoutUpdate(BaseModel):
    """Bulk-обновление позиций нод в node-редакторе сюжета.

    Используется при drag-and-drop в xyflow-canvas. Без bulk-endpoint каждое
    движение мыши превратилось бы в N HTTP-запросов (с 30-шаговым seed-сюжетом
    это unusable). Frontend дебаунсит изменения и шлёт все позиции одной
    транзакцией.
    """

    positions: list[StoryLayoutItem] = Field(..., max_length=500)


class StoryNarrationCueReorderRequest(BaseModel):
    """Bulk reorder cues внутри одного step.

    Принимает упорядоченный список UUID; backend выставит sort_order по
    индексу (0, 1, 2, ...). Все cue_id должны принадлежать одному step.
    """

    cue_ids: list[UUID] = Field(..., min_length=1, max_length=200)


# =============================================================================
# StoryStep
# =============================================================================


# Допустимые виды step. Импортируем из модели чтобы не дублировать.
StoryStepKind = Literal[
    "narration",
    "role_action",
    "discussion",
    "voting",
    "night_resolve",
    "day_resolve",
    "pause",
    "branch",
    "end",
]


class StoryStepRead(BaseModel):
    id: str
    slug: str
    kind: StoryStepKind
    label: str
    payload: dict[str, Any]
    position_x: int
    position_y: int
    cues: list[StoryNarrationCueRead] = []


class StoryStepCreate(BaseModel):
    slug: str = Field(..., min_length=1, max_length=80)
    kind: StoryStepKind
    label: str = Field(default="", max_length=120)
    payload: dict[str, Any] = Field(default_factory=dict)
    position_x: int = Field(default=0, ge=-100_000, le=100_000)
    position_y: int = Field(default=0, ge=-100_000, le=100_000)

    @field_validator("slug")
    @classmethod
    def _validate_slug(cls, v: str) -> str:
        if not _SLUG_RE.match(v):
            raise ValueError("slug должен быть [a-z0-9_], 1..80 символов")
        return v

    @field_validator("kind")
    @classmethod
    def _validate_kind(cls, v: str) -> str:
        if v not in STORY_STEP_KINDS:
            # Резерв на случай рассинхрона между Literal и константой.
            raise ValueError(f"kind должен быть одним из {STORY_STEP_KINDS}")
        return v


class StoryStepUpdate(BaseModel):
    """PATCH: незаданные поля не меняются. ``kind`` и ``slug`` менять можно,
    но это потенциально breaking — frontend-редактор должен предупреждать.
    """

    slug: str | None = Field(default=None, min_length=1, max_length=80)
    kind: StoryStepKind | None = None
    label: str | None = Field(default=None, max_length=120)
    payload: dict[str, Any] | None = None
    position_x: int | None = Field(default=None, ge=-100_000, le=100_000)
    position_y: int | None = Field(default=None, ge=-100_000, le=100_000)

    @field_validator("slug")
    @classmethod
    def _validate_slug(cls, v: str | None) -> str | None:
        if v is not None and not _SLUG_RE.match(v):
            raise ValueError("slug должен быть [a-z0-9_], 1..80 символов")
        return v


# =============================================================================
# StoryTransition
# =============================================================================


class StoryTransitionRead(BaseModel):
    id: str
    from_step_id: str
    to_step_id: str
    condition: dict[str, Any] | None
    priority: int


class StoryTransitionCreate(BaseModel):
    from_step_id: UUID
    to_step_id: UUID
    # Условие validate-ится через Condition union (приходит как dict, парсим
    # отдельно в endpoint'е через ``Condition.model_validate(condition)``,
    # чтобы получить детальную ошибку поля).
    condition: dict[str, Any] | None = None
    priority: int = Field(default=0, ge=0, le=1000)

    @model_validator(mode="after")
    def _no_self_loop(self) -> "StoryTransitionCreate":
        if self.from_step_id == self.to_step_id:
            raise ValueError("from_step_id и to_step_id должны различаться")
        return self


class StoryTransitionUpdate(BaseModel):
    """PATCH: незаданные поля не меняются. Чтобы сбросить condition в null
    (превратить в безусловный edge) → передать ``unset_condition=True``.
    """

    from_step_id: UUID | None = None
    to_step_id: UUID | None = None
    condition: dict[str, Any] | None = None
    unset_condition: bool = False
    priority: int | None = Field(default=None, ge=0, le=1000)


# =============================================================================
# Story (root)
# =============================================================================


class StoryListItem(BaseModel):
    """Запись в списке сюжетов для admin-таблицы."""

    id: str
    slug: str
    version: int
    name: str
    description: str | None
    is_active: bool
    is_obsolete: bool
    use_only_own_triggers: bool = False
    superseded_by_id: str | None
    created_at: datetime
    updated_at: datetime
    # Подсчёты для UI: сколько сейчас игр на этой версии и сколько шагов.
    # Заполняются роутером отдельным агрегатным запросом.
    steps_count: int = 0
    active_sessions_count: int = 0


class StoryListResponse(BaseModel):
    stories: list[StoryListItem]


class StoryReadFull(BaseModel):
    """Полный граф для редактора (eager-loaded все steps/transitions/cues/settings)."""

    id: str
    slug: str
    version: int
    name: str
    description: str | None
    is_active: bool
    is_obsolete: bool
    use_only_own_triggers: bool = False
    superseded_by_id: str | None
    entry_step_id: str | None
    created_at: datetime
    updated_at: datetime
    settings: StorySettingsRead | None = None
    steps: list[StoryStepRead] = []
    transitions: list[StoryTransitionRead] = []


class StoryCreate(BaseModel):
    slug: str = Field(..., min_length=1, max_length=80)
    name: str = Field(..., min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    settings: StorySettingsUpdate | None = None

    @field_validator("slug")
    @classmethod
    def _validate_slug(cls, v: str) -> str:
        if not _SLUG_RE.match(v):
            raise ValueError("slug должен быть [a-z0-9_], 1..80 символов")
        return v


class StoryUpdate(BaseModel):
    """PATCH-style update сюжета.

    Если сюжет имеет активные сессии (`session.story_id == this`), вместо
    in-place update endpoint клонирует Story в новую запись с version+1
    (см. design doc §11.2). Это решается на уровне роутера, а не схемы.

    Поля ``slug`` и ``version`` неизменяемы напрямую (slug — потому что
    идентифицирует «логический сюжет», version — потому что управляется
    versioning logic).
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    is_active: bool | None = None
    is_obsolete: bool | None = None
    # Этап 6.6: изоляция от global-namespace триггеров. None = не менять.
    use_only_own_triggers: bool | None = None
    entry_step_id: UUID | None = None


# =============================================================================
# Import / Export
# =============================================================================


class StoryNarrationCueExport(BaseModel):
    """Cue в JSON-снапшоте: вместо trigger_id используем trigger_slug
    (стабильный ключ между окружениями).
    """

    sort_order: int
    trigger_slug: str | None = None
    pause_before_ms: int = 0
    pause_after_ms: int = 0
    override_text: str | None = None
    override_duration_ms: int | None = None


class StoryStepExport(BaseModel):
    slug: str
    kind: StoryStepKind
    label: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    position_x: int = 0
    position_y: int = 0
    cues: list[StoryNarrationCueExport] = []


class StoryTransitionExport(BaseModel):
    """Transition в JSON-снапшоте: ссылки на step через ``from_slug`` /
    ``to_slug``, а не UUID — переносится между окружениями.
    """

    from_slug: str
    to_slug: str
    condition: dict[str, Any] | None = None
    priority: int = 0


class StorySettingsExport(BaseModel):
    inter_cue_pause_seconds: Decimal = Decimal("0")
    timer_multiplier_default: Decimal = Decimal("1")
    karaoke_enabled: bool = True


class StoryExport(BaseModel):
    """Полный JSON-снапшот сюжета. Используется для:
    - бэкапов через ``GET /api/admin/stories/{id}/export``
    - переноса между окружениями (dev → prod)
    - дублирования через ``POST /api/admin/stories/{id}/duplicate`` (внутренний flow)

    Не включает: id, version, is_active, is_obsolete, superseded_by_id, timestamps.
    Всё это backend проставляет на импорте.
    """

    schema_version: Literal[1] = 1
    slug: str
    name: str
    description: str | None = None
    entry_slug: str | None = None
    settings: StorySettingsExport = Field(default_factory=StorySettingsExport)
    steps: list[StoryStepExport] = []
    transitions: list[StoryTransitionExport] = []


class StoryImportRequest(BaseModel):
    """Импорт сюжета из JSON-снапшота.

    Поведение:
    - ``slug`` берётся из payload, если уже есть запись с этим slug — backend
      возвращает 409 (или вы можете предложить ``override_slug`` параметр для
      ремаппинга, но в MVP — fail).
    - Все trigger_slug резолвятся в trigger_id; пропавшие slug'и логируются,
      cue остаётся text-only (override_text=null → потом поправит админ).
    - Все step.slug'и должны быть уникальны в payload (валидация перед commit).
    - Все transition.from_slug / to_slug должны существовать в steps.
    - ``entry_slug`` (если задан) тоже должен существовать в steps.

    Создаётся новая Story с version=1, is_active=true.
    """

    payload: StoryExport
    override_slug: str | None = Field(default=None, min_length=1, max_length=80)

    @field_validator("override_slug")
    @classmethod
    def _validate_override_slug(cls, v: str | None) -> str | None:
        if v is not None and not _SLUG_RE.match(v):
            raise ValueError("override_slug должен быть [a-z0-9_], 1..80 символов")
        return v


# =============================================================================
# Pydantic v2: rebuild forward references для рекурсивных условий
# =============================================================================
AllCondition.model_rebuild()
AnyCondition.model_rebuild()
NotCondition.model_rebuild()
