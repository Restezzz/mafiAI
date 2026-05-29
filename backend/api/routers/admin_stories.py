"""Admin endpoints для управления Story Engine.

Все эндпоинты гейтированы ``require_admin``. Содержит:
- CRUD сюжетов (Story): list, get full, create, update, delete, duplicate
- CRUD шагов (StoryStep): create, update, delete + entry pointer
- CRUD рёбер (StoryTransition): create, update, delete
- CRUD фраз (StoryNarrationCue): create, update, delete + bulk reorder
- Settings update
- Export / Import JSON-снапшота сюжета

В этапе 1 versioning logic (clone-on-update при наличии активных сессий)
**не реализован** — используется обычный in-place update. Полный versioning
появится в этапе 2 после введения ``Session.story_id`` колонки.

См. backend/docs/story_engine_design.md §9 для полной API спеки.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.deps import get_db, require_admin
from core.exceptions import GameError
from core.logging import log_event
from models.narrator import NarratorTrigger
from models.story import (
    Story,
    StoryNarrationCue,
    StorySettings,
    StoryStep,
    StoryTransition,
)
from models.user import User
from schemas.story import (
    Condition,
    StoryCreate,
    StoryExport,
    StoryImportRequest,
    StoryLayoutUpdate,
    StoryListItem,
    StoryListResponse,
    StoryNarrationCueCreate,
    StoryNarrationCueExport,
    StoryNarrationCueRead,
    StoryNarrationCueReorderRequest,
    StoryNarrationCueUpdate,
    StoryReadFull,
    StorySettingsExport,
    StorySettingsRead,
    StorySettingsUpdate,
    StoryStepCreate,
    StoryStepExport,
    StoryStepRead,
    StoryStepUpdate,
    StoryTransitionCreate,
    StoryTransitionExport,
    StoryTransitionRead,
    StoryTransitionUpdate,
    StoryUpdate,
)


logger = logging.getLogger(__name__)

router = APIRouter()


# Pydantic discriminated-union условий — кешируем TypeAdapter на модуле,
# чтобы не пересоздавать при каждом запросе.
_condition_adapter: TypeAdapter[Any] = TypeAdapter(Condition)


def _validate_condition(value: dict[str, Any] | None) -> dict[str, Any] | None:
    """Проверяет condition (включая рекурсивные all/any/not).

    Возвращает оригинальный dict если ок, иначе кидает GameError(422).
    """
    if value is None:
        return None
    try:
        _condition_adapter.validate_python(value)
    except ValidationError as exc:
        raise GameError(
            422,
            "invalid_condition",
            f"Некорректное condition: {exc.errors()[0]['msg']}" if exc.errors() else "Некорректное condition",
        ) from exc
    return value


# ============================================================================
# Сериализация ORM → pydantic
# ============================================================================


def _serialize_cue(cue: StoryNarrationCue) -> StoryNarrationCueRead:
    return StoryNarrationCueRead(
        id=str(cue.id),
        sort_order=cue.sort_order,
        trigger_id=str(cue.trigger_id) if cue.trigger_id else None,
        trigger_slug=cue.trigger.slug if cue.trigger else None,
        pause_before_ms=cue.pause_before_ms,
        pause_after_ms=cue.pause_after_ms,
        override_text=cue.override_text,
        override_duration_ms=cue.override_duration_ms,
    )


def _serialize_step(step: StoryStep) -> StoryStepRead:
    return StoryStepRead(
        id=str(step.id),
        slug=step.slug,
        kind=step.kind,
        label=step.label,
        payload=step.payload or {},
        position_x=step.position_x,
        position_y=step.position_y,
        cues=[_serialize_cue(c) for c in sorted(step.cues, key=lambda c: c.sort_order)],
    )


def _serialize_transition(t: StoryTransition) -> StoryTransitionRead:
    return StoryTransitionRead(
        id=str(t.id),
        from_step_id=str(t.from_step_id),
        to_step_id=str(t.to_step_id),
        condition=t.condition,
        priority=t.priority,
    )


def _serialize_settings(s: StorySettings | None) -> StorySettingsRead | None:
    if s is None:
        return None
    return StorySettingsRead(
        inter_cue_pause_seconds=s.inter_cue_pause_seconds,
        timer_multiplier_default=s.timer_multiplier_default,
        karaoke_enabled=s.karaoke_enabled,
    )


def _serialize_story_full(story: Story) -> StoryReadFull:
    return StoryReadFull(
        id=str(story.id),
        slug=story.slug,
        version=story.version,
        name=story.name,
        description=story.description,
        is_active=story.is_active,
        is_obsolete=story.is_obsolete,
        use_only_own_triggers=story.use_only_own_triggers,
        superseded_by_id=str(story.superseded_by_id) if story.superseded_by_id else None,
        entry_step_id=str(story.entry_step_id) if story.entry_step_id else None,
        created_at=story.created_at,
        updated_at=story.updated_at,
        settings=_serialize_settings(story.settings),
        steps=[_serialize_step(s) for s in story.steps],
        transitions=[_serialize_transition(t) for t in story.transitions],
    )


# ============================================================================
# DB-helpers
# ============================================================================


async def _load_story_full(db: AsyncSession, story_id: UUID) -> Story:
    """Eager-load полный граф (steps → cues → trigger; transitions; settings)."""
    stmt = (
        select(Story)
        .where(Story.id == story_id)
        .options(
            selectinload(Story.settings),
            selectinload(Story.steps).selectinload(StoryStep.cues).selectinload(
                StoryNarrationCue.trigger
            ),
            selectinload(Story.transitions),
        )
    )
    story = await db.scalar(stmt)
    if story is None:
        raise GameError(404, "story_not_found", "Сюжет не найден")
    return story


async def _get_step_or_404(
    db: AsyncSession, story_id: UUID, step_id: UUID
) -> StoryStep:
    step = await db.scalar(
        select(StoryStep).where(
            StoryStep.id == step_id, StoryStep.story_id == story_id
        )
    )
    if step is None:
        raise GameError(404, "step_not_found", "Шаг сюжета не найден")
    return step


async def _get_transition_or_404(
    db: AsyncSession, story_id: UUID, transition_id: UUID
) -> StoryTransition:
    t = await db.scalar(
        select(StoryTransition).where(
            StoryTransition.id == transition_id,
            StoryTransition.story_id == story_id,
        )
    )
    if t is None:
        raise GameError(404, "transition_not_found", "Переход не найден")
    return t


async def _get_cue_or_404(
    db: AsyncSession, story_id: UUID, cue_id: UUID
) -> StoryNarrationCue:
    """Проверяет что cue принадлежит шагу из этого story."""
    stmt = (
        select(StoryNarrationCue)
        .join(StoryStep, StoryNarrationCue.step_id == StoryStep.id)
        .where(StoryNarrationCue.id == cue_id, StoryStep.story_id == story_id)
        .options(selectinload(StoryNarrationCue.trigger))
    )
    cue = await db.scalar(stmt)
    if cue is None:
        raise GameError(404, "cue_not_found", "Фраза не найдена")
    return cue


async def _ensure_unique_slug(db: AsyncSession, slug: str) -> None:
    """409 если уже есть Story с таким slug (любая версия)."""
    exists = await db.scalar(
        select(func.count()).select_from(Story).where(Story.slug == slug)
    )
    if exists:
        raise GameError(
            409, "slug_already_exists", f"Сюжет со slug={slug!r} уже существует"
        )


async def _ensure_unique_step_slug(
    db: AsyncSession, story_id: UUID, slug: str, exclude_id: UUID | None = None
) -> None:
    """409 если в этом story уже есть Step с таким slug."""
    stmt = select(func.count()).select_from(StoryStep).where(
        StoryStep.story_id == story_id, StoryStep.slug == slug
    )
    if exclude_id:
        stmt = stmt.where(StoryStep.id != exclude_id)
    count = await db.scalar(stmt)
    if count:
        raise GameError(
            409,
            "step_slug_exists",
            f"Step со slug={slug!r} уже есть в сюжете",
        )


# ============================================================================
# Stories: list / get / create / update / delete / duplicate
# ============================================================================


@router.get("/stories", response_model=StoryListResponse)
async def list_stories(
    include_obsolete: bool = Query(default=False, description="Включить is_obsolete=true"),
    include_inactive: bool = Query(default=True, description="Включить старые версии (is_active=false)"),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryListResponse:
    """Список сюжетов с подсчётом шагов на каждый.

    Фильтры:
    - ``include_obsolete=true`` — показать архивированные.
    - ``include_inactive=false`` — только активные версии (latest на slug).

    ``active_sessions_count`` пока всегда 0 — будет реализовано в этапе 2,
    когда появится ``Session.story_id``.
    """
    stmt = select(Story).order_by(Story.slug, Story.version.desc())
    if not include_obsolete:
        stmt = stmt.where(Story.is_obsolete.is_(False))
    if not include_inactive:
        stmt = stmt.where(Story.is_active.is_(True))

    stories = (await db.scalars(stmt)).all()

    # Подсчёт steps_count одним группирующим запросом.
    steps_by_story = dict(
        (await db.execute(
            select(StoryStep.story_id, func.count(StoryStep.id))
            .group_by(StoryStep.story_id)
        )).all()
    )

    items: list[StoryListItem] = []
    for s in stories:
        items.append(
            StoryListItem(
                id=str(s.id),
                slug=s.slug,
                version=s.version,
                name=s.name,
                description=s.description,
                is_active=s.is_active,
                is_obsolete=s.is_obsolete,
                use_only_own_triggers=s.use_only_own_triggers,
                superseded_by_id=str(s.superseded_by_id) if s.superseded_by_id else None,
                created_at=s.created_at,
                updated_at=s.updated_at,
                steps_count=int(steps_by_story.get(s.id, 0)),
                active_sessions_count=0,  # этап 2
            )
        )
    return StoryListResponse(stories=items)


@router.get("/stories/{story_id}", response_model=StoryReadFull)
async def get_story(
    story_id: UUID,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryReadFull:
    """Полный граф сюжета (steps + transitions + cues + settings)."""
    story = await _load_story_full(db, story_id)
    return _serialize_story_full(story)


@router.post("/stories", response_model=StoryReadFull, status_code=201)
async def create_story(
    payload: StoryCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryReadFull:
    """Создать новый сюжет (без шагов).

    Создаётся как version=1, is_active=true. Шаги/переходы/фразы добавляются
    отдельными endpoint'ами.
    """
    await _ensure_unique_slug(db, payload.slug)

    story = Story(
        id=uuid.uuid4(),
        slug=payload.slug,
        version=1,
        name=payload.name,
        description=payload.description,
        is_active=True,
        is_obsolete=False,
    )
    db.add(story)

    # Settings: используем переданные значения или дефолты.
    s_data = payload.settings.model_dump(exclude_unset=True) if payload.settings else {}
    db.add(
        StorySettings(
            story_id=story.id,
            inter_cue_pause_seconds=s_data.get("inter_cue_pause_seconds", 0),
            timer_multiplier_default=s_data.get("timer_multiplier_default", 1),
            karaoke_enabled=s_data.get("karaoke_enabled", True),
        )
    )

    await db.commit()
    log_event(
        logger, logging.INFO, "story.created",
        "Story created", story_id=str(story.id), slug=story.slug, by_user=str(admin.id),
    )
    fresh = await _load_story_full(db, story.id)
    return _serialize_story_full(fresh)


@router.put("/stories/{story_id}", response_model=StoryReadFull)
async def update_story(
    story_id: UUID,
    payload: StoryUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryReadFull:
    """Обновить метаданные сюжета (name, description, is_active, is_obsolete, entry_step_id).

    В этапе 1 — простой in-place update. Versioning через clone-on-update —
    в этапе 2 (требует ``Session.story_id``).
    """
    story = await _load_story_full(db, story_id)
    data = payload.model_dump(exclude_unset=True)

    if "entry_step_id" in data and data["entry_step_id"] is not None:
        # Проверяем что entry_step принадлежит этому story.
        entry_id = data["entry_step_id"]
        belongs = await db.scalar(
            select(func.count()).select_from(StoryStep).where(
                StoryStep.id == entry_id, StoryStep.story_id == story_id
            )
        )
        if not belongs:
            raise GameError(
                422, "invalid_entry_step",
                "entry_step_id должен ссылаться на шаг этого же сюжета",
            )

    for key, value in data.items():
        setattr(story, key, value)

    await db.commit()
    log_event(
        logger, logging.INFO, "story.updated",
        "Story updated", story_id=str(story.id), fields=list(data.keys()),
        by_user=str(admin.id),
    )
    fresh = await _load_story_full(db, story_id)
    return _serialize_story_full(fresh)


@router.delete("/stories/{story_id}", status_code=204)
async def delete_story(
    story_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Удалить сюжет полностью (cascadnewline удалит все steps/transitions/cues/settings).

    В этапе 1 — без проверки активных сессий (нет ``Session.story_id`` ещё).
    """
    story = await db.scalar(select(Story).where(Story.id == story_id))
    if story is None:
        raise GameError(404, "story_not_found", "Сюжет не найден")
    await db.delete(story)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.deleted",
        "Story deleted", story_id=str(story_id), slug=story.slug,
        by_user=str(admin.id),
    )


@router.post("/stories/{story_id}/duplicate", response_model=StoryReadFull, status_code=201)
async def duplicate_story(
    story_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryReadFull:
    """Клонировать сюжет под новым slug ``<original>_copy_<N>``."""
    src = await _load_story_full(db, story_id)
    base_slug = f"{src.slug}_copy"
    # Найти первый свободный suffix.
    n = 1
    while True:
        candidate = f"{base_slug}_{n}"
        exists = await db.scalar(
            select(func.count()).select_from(Story).where(Story.slug == candidate)
        )
        if not exists:
            break
        n += 1

    new_id = await _clone_story_internal(
        db, src, new_slug=candidate, new_name=f"{src.name} (копия)"
    )
    await db.commit()
    log_event(
        logger, logging.INFO, "story.duplicated",
        "Story duplicated", source_id=str(story_id), new_id=str(new_id),
        by_user=str(admin.id),
    )
    fresh = await _load_story_full(db, new_id)
    return _serialize_story_full(fresh)


async def _clone_story_internal(
    db: AsyncSession, src: Story, *, new_slug: str, new_name: str | None = None
) -> UUID:
    """Клонирует Story + все steps/transitions/cues/settings под новым slug.

    Возвращает id новой Story. Не делает commit — caller отвечает.
    """
    new_story = Story(
        id=uuid.uuid4(),
        slug=new_slug,
        version=1,
        name=new_name or src.name,
        description=src.description,
        is_active=True,
        is_obsolete=False,
    )
    db.add(new_story)

    if src.settings:
        db.add(
            StorySettings(
                story_id=new_story.id,
                inter_cue_pause_seconds=src.settings.inter_cue_pause_seconds,
                timer_multiplier_default=src.settings.timer_multiplier_default,
                karaoke_enabled=src.settings.karaoke_enabled,
            )
        )

    # Маппинг старый_step_id → новый_step_id (нужен для transitions).
    step_id_map: dict[UUID, UUID] = {}
    for step in src.steps:
        new_step_id = uuid.uuid4()
        step_id_map[step.id] = new_step_id
        db.add(
            StoryStep(
                id=new_step_id,
                story_id=new_story.id,
                slug=step.slug,
                kind=step.kind,
                label=step.label,
                payload=dict(step.payload or {}),
                position_x=step.position_x,
                position_y=step.position_y,
            )
        )

    await db.flush()  # FK на step_id для cues/transitions

    for step in src.steps:
        for cue in step.cues:
            db.add(
                StoryNarrationCue(
                    id=uuid.uuid4(),
                    step_id=step_id_map[step.id],
                    sort_order=cue.sort_order,
                    trigger_id=cue.trigger_id,
                    pause_before_ms=cue.pause_before_ms,
                    pause_after_ms=cue.pause_after_ms,
                    override_text=cue.override_text,
                    override_duration_ms=cue.override_duration_ms,
                )
            )

    for t in src.transitions:
        db.add(
            StoryTransition(
                id=uuid.uuid4(),
                story_id=new_story.id,
                from_step_id=step_id_map[t.from_step_id],
                to_step_id=step_id_map[t.to_step_id],
                condition=t.condition,
                priority=t.priority,
            )
        )

    if src.entry_step_id and src.entry_step_id in step_id_map:
        new_story.entry_step_id = step_id_map[src.entry_step_id]

    return new_story.id


# ============================================================================
# Settings
# ============================================================================


@router.put("/stories/{story_id}/settings", response_model=StorySettingsRead)
async def update_settings(
    story_id: UUID,
    payload: StorySettingsUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StorySettingsRead:
    """PATCH-style update настроек сюжета."""
    settings = await db.scalar(
        select(StorySettings).where(StorySettings.story_id == story_id)
    )
    if settings is None:
        # Сюжет может не иметь settings (например создан старым кодом) —
        # создаём дефолтную запись.
        story_exists = await db.scalar(
            select(func.count()).select_from(Story).where(Story.id == story_id)
        )
        if not story_exists:
            raise GameError(404, "story_not_found", "Сюжет не найден")
        settings = StorySettings(story_id=story_id)
        db.add(settings)

    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(settings, key, value)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.settings_updated",
        "Story settings updated", story_id=str(story_id),
        fields=list(data.keys()), by_user=str(admin.id),
    )
    return _serialize_settings(settings)  # type: ignore[return-value]


# ============================================================================
# Steps CRUD
# ============================================================================


@router.post(
    "/stories/{story_id}/steps", response_model=StoryStepRead, status_code=201
)
async def create_step(
    story_id: UUID,
    payload: StoryStepCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryStepRead:
    # Story exists?
    story_exists = await db.scalar(
        select(func.count()).select_from(Story).where(Story.id == story_id)
    )
    if not story_exists:
        raise GameError(404, "story_not_found", "Сюжет не найден")
    await _ensure_unique_step_slug(db, story_id, payload.slug)

    step = StoryStep(
        id=uuid.uuid4(),
        story_id=story_id,
        slug=payload.slug,
        kind=payload.kind,
        label=payload.label,
        payload=payload.payload,
        position_x=payload.position_x,
        position_y=payload.position_y,
    )
    db.add(step)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.step_created",
        "Step created", story_id=str(story_id), step_id=str(step.id),
        slug=step.slug, kind=step.kind, by_user=str(admin.id),
    )
    # Подгружаем cues (пустой список) для консистентного ответа.
    fresh = await db.scalar(
        select(StoryStep).where(StoryStep.id == step.id).options(
            selectinload(StoryStep.cues).selectinload(StoryNarrationCue.trigger)
        )
    )
    return _serialize_step(fresh)  # type: ignore[arg-type]


@router.put(
    "/stories/{story_id}/steps/{step_id}", response_model=StoryStepRead
)
async def update_step(
    story_id: UUID,
    step_id: UUID,
    payload: StoryStepUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryStepRead:
    step = await _get_step_or_404(db, story_id, step_id)
    data = payload.model_dump(exclude_unset=True)

    if "slug" in data and data["slug"] != step.slug:
        await _ensure_unique_step_slug(db, story_id, data["slug"], exclude_id=step.id)

    for key, value in data.items():
        setattr(step, key, value)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.step_updated",
        "Step updated", step_id=str(step_id), fields=list(data.keys()),
        by_user=str(admin.id),
    )
    fresh = await db.scalar(
        select(StoryStep).where(StoryStep.id == step_id).options(
            selectinload(StoryStep.cues).selectinload(StoryNarrationCue.trigger)
        )
    )
    return _serialize_step(fresh)  # type: ignore[arg-type]


@router.delete("/stories/{story_id}/steps/{step_id}", status_code=204)
async def delete_step(
    story_id: UUID,
    step_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    step = await _get_step_or_404(db, story_id, step_id)
    # Если этот шаг — entry, обнуляем.
    story = await db.scalar(select(Story).where(Story.id == story_id))
    if story and story.entry_step_id == step_id:
        story.entry_step_id = None
    await db.delete(step)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.step_deleted",
        "Step deleted", step_id=str(step_id), by_user=str(admin.id),
    )


@router.patch("/stories/{story_id}/layout", status_code=200)
async def update_layout(
    story_id: UUID,
    payload: StoryLayoutUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Bulk-обновление позиций нод в node-редакторе (этап 4).

    Принимает массив ``{step_id, position_x, position_y}`` и обновляет все
    в одной транзакции. Защищает от типичной ошибки — обновления чужих
    шагов: проверяет что все ``step_id`` принадлежат указанному сюжету.

    Шаги, не указанные в payload, остаются нетронутыми (это batch-update,
    не полная замена). Это позволяет фронту слать только сдвинутые ноды.
    """
    # Загрузим все указанные шаги одним запросом — чтобы потом проверить
    # принадлежность к story и не делать N+1 на update.
    requested_ids = {item.step_id for item in payload.positions}
    if not requested_ids:
        return {"updated": 0}

    stmt = select(StoryStep).where(
        StoryStep.story_id == story_id,
        StoryStep.id.in_(requested_ids),
    )
    steps = (await db.scalars(stmt)).all()
    found_ids = {s.id for s in steps}

    missing = requested_ids - found_ids
    if missing:
        raise GameError(
            404,
            "step_not_found",
            f"Шаги не найдены в сюжете: {sorted(str(i) for i in missing)}",
        )

    by_id = {s.id: s for s in steps}
    for item in payload.positions:
        step = by_id[item.step_id]
        step.position_x = item.position_x
        step.position_y = item.position_y

    await db.commit()
    log_event(
        logger, logging.INFO, "story.layout_updated",
        "Story layout updated",
        story_id=str(story_id),
        updated_count=len(payload.positions),
        by_user=str(admin.id),
    )
    return {"updated": len(payload.positions)}


# ============================================================================
# Transitions CRUD
# ============================================================================


@router.post(
    "/stories/{story_id}/transitions",
    response_model=StoryTransitionRead,
    status_code=201,
)
async def create_transition(
    story_id: UUID,
    payload: StoryTransitionCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryTransitionRead:
    # Проверяем что оба шага принадлежат этому story.
    await _get_step_or_404(db, story_id, payload.from_step_id)
    await _get_step_or_404(db, story_id, payload.to_step_id)
    cond = _validate_condition(payload.condition)

    t = StoryTransition(
        id=uuid.uuid4(),
        story_id=story_id,
        from_step_id=payload.from_step_id,
        to_step_id=payload.to_step_id,
        condition=cond,
        priority=payload.priority,
    )
    db.add(t)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.transition_created",
        "Transition created", story_id=str(story_id), transition_id=str(t.id),
        by_user=str(admin.id),
    )
    return _serialize_transition(t)


@router.put(
    "/stories/{story_id}/transitions/{transition_id}",
    response_model=StoryTransitionRead,
)
async def update_transition(
    story_id: UUID,
    transition_id: UUID,
    payload: StoryTransitionUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryTransitionRead:
    t = await _get_transition_or_404(db, story_id, transition_id)
    data = payload.model_dump(exclude_unset=True)

    if data.get("from_step_id"):
        await _get_step_or_404(db, story_id, data["from_step_id"])
    if data.get("to_step_id"):
        await _get_step_or_404(db, story_id, data["to_step_id"])

    if data.get("unset_condition"):
        t.condition = None
    elif "condition" in data:
        t.condition = _validate_condition(data["condition"])
    data.pop("unset_condition", None)
    data.pop("condition", None)

    # Self-loop check после применения.
    new_from = data.get("from_step_id", t.from_step_id)
    new_to = data.get("to_step_id", t.to_step_id)
    if new_from == new_to:
        raise GameError(
            422, "self_loop",
            "from_step_id и to_step_id должны различаться",
        )

    for key, value in data.items():
        setattr(t, key, value)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.transition_updated",
        "Transition updated", transition_id=str(transition_id),
        by_user=str(admin.id),
    )
    return _serialize_transition(t)


@router.delete(
    "/stories/{story_id}/transitions/{transition_id}", status_code=204
)
async def delete_transition(
    story_id: UUID,
    transition_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    t = await _get_transition_or_404(db, story_id, transition_id)
    await db.delete(t)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.transition_deleted",
        "Transition deleted", transition_id=str(transition_id),
        by_user=str(admin.id),
    )


# ============================================================================
# Narration cues CRUD + reorder
# ============================================================================


@router.post(
    "/stories/{story_id}/steps/{step_id}/cues",
    response_model=StoryNarrationCueRead,
    status_code=201,
)
async def create_cue(
    story_id: UUID,
    step_id: UUID,
    payload: StoryNarrationCueCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryNarrationCueRead:
    step = await _get_step_or_404(db, story_id, step_id)
    if step.kind != "narration":
        raise GameError(
            422, "invalid_step_kind",
            f"Cue можно добавлять только в kind='narration', не в '{step.kind}'",
        )

    # Проверка trigger_id существует.
    if payload.trigger_id:
        trig = await db.scalar(
            select(NarratorTrigger).where(NarratorTrigger.id == payload.trigger_id)
        )
        if trig is None:
            raise GameError(404, "trigger_not_found", "Триггер не найден")

    # Проверка sort_order не занят.
    occupied = await db.scalar(
        select(func.count()).select_from(StoryNarrationCue).where(
            StoryNarrationCue.step_id == step_id,
            StoryNarrationCue.sort_order == payload.sort_order,
        )
    )
    if occupied:
        raise GameError(
            409, "sort_order_taken",
            f"sort_order={payload.sort_order} уже занят, сначала сдвиньте через reorder",
        )

    cue = StoryNarrationCue(
        id=uuid.uuid4(),
        step_id=step_id,
        sort_order=payload.sort_order,
        trigger_id=payload.trigger_id,
        pause_before_ms=payload.pause_before_ms,
        pause_after_ms=payload.pause_after_ms,
        override_text=payload.override_text,
        override_duration_ms=payload.override_duration_ms,
    )
    db.add(cue)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.cue_created",
        "Cue created", step_id=str(step_id), cue_id=str(cue.id),
        by_user=str(admin.id),
    )
    fresh = await db.scalar(
        select(StoryNarrationCue).where(StoryNarrationCue.id == cue.id).options(
            selectinload(StoryNarrationCue.trigger)
        )
    )
    return _serialize_cue(fresh)  # type: ignore[arg-type]


@router.put(
    "/stories/{story_id}/cues/{cue_id}", response_model=StoryNarrationCueRead
)
async def update_cue(
    story_id: UUID,
    cue_id: UUID,
    payload: StoryNarrationCueUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryNarrationCueRead:
    cue = await _get_cue_or_404(db, story_id, cue_id)
    data = payload.model_dump(exclude_unset=True)

    if data.get("unset_trigger"):
        cue.trigger_id = None
    elif "trigger_id" in data and data["trigger_id"]:
        trig = await db.scalar(
            select(NarratorTrigger).where(NarratorTrigger.id == data["trigger_id"])
        )
        if trig is None:
            raise GameError(404, "trigger_not_found", "Триггер не найден")
        cue.trigger_id = data["trigger_id"]
    data.pop("unset_trigger", None)
    data.pop("trigger_id", None)

    # sort_order: если меняется на занятый — 409.
    if "sort_order" in data and data["sort_order"] != cue.sort_order:
        occupied = await db.scalar(
            select(func.count()).select_from(StoryNarrationCue).where(
                StoryNarrationCue.step_id == cue.step_id,
                StoryNarrationCue.sort_order == data["sort_order"],
                StoryNarrationCue.id != cue.id,
            )
        )
        if occupied:
            raise GameError(
                409, "sort_order_taken",
                "sort_order занят. Используйте reorder endpoint",
            )

    for key, value in data.items():
        setattr(cue, key, value)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.cue_updated",
        "Cue updated", cue_id=str(cue_id), by_user=str(admin.id),
    )
    fresh = await db.scalar(
        select(StoryNarrationCue).where(StoryNarrationCue.id == cue_id).options(
            selectinload(StoryNarrationCue.trigger)
        )
    )
    return _serialize_cue(fresh)  # type: ignore[arg-type]


@router.delete("/stories/{story_id}/cues/{cue_id}", status_code=204)
async def delete_cue(
    story_id: UUID,
    cue_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    cue = await _get_cue_or_404(db, story_id, cue_id)
    await db.delete(cue)
    await db.commit()
    log_event(
        logger, logging.INFO, "story.cue_deleted",
        "Cue deleted", cue_id=str(cue_id), by_user=str(admin.id),
    )


@router.post(
    "/stories/{story_id}/steps/{step_id}/cues/reorder",
    response_model=list[StoryNarrationCueRead],
)
async def reorder_cues(
    story_id: UUID,
    step_id: UUID,
    payload: StoryNarrationCueReorderRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[StoryNarrationCueRead]:
    """Атомарный bulk reorder cues внутри одного step.

    Принимает упорядоченный список cue_ids. Backend выставляет sort_order
    по индексу (0, 1, 2, ...). Все cue_id должны принадлежать этому step.
    Возвращает обновлённый список cues.
    """
    await _get_step_or_404(db, story_id, step_id)

    # Загружаем все cues этого шага и проверяем consistency с payload.
    existing = (
        await db.scalars(
            select(StoryNarrationCue).where(StoryNarrationCue.step_id == step_id)
        )
    ).all()
    existing_by_id = {c.id: c for c in existing}

    requested = list(payload.cue_ids)
    if set(requested) != set(existing_by_id.keys()):
        raise GameError(
            422, "reorder_mismatch",
            "Список cue_ids должен в точности соответствовать существующим cues этого step",
        )

    # Двух-фазный апдейт чтобы не нарушить uq_story_cues_step_sort: сначала
    # ставим временные большие значения, потом финальные. Иначе при свопе
    # 0↔1 нарваться на UNIQUE violation.
    OFFSET = 10_000
    for cue in existing:
        cue.sort_order = cue.sort_order + OFFSET
    await db.flush()

    for new_order, cue_id in enumerate(requested):
        existing_by_id[cue_id].sort_order = new_order
    await db.commit()

    fresh = (
        await db.scalars(
            select(StoryNarrationCue)
            .where(StoryNarrationCue.step_id == step_id)
            .options(selectinload(StoryNarrationCue.trigger))
            .order_by(StoryNarrationCue.sort_order)
        )
    ).all()
    log_event(
        logger, logging.INFO, "story.cues_reordered",
        "Cues reordered", step_id=str(step_id), count=len(fresh),
        by_user=str(admin.id),
    )
    return [_serialize_cue(c) for c in fresh]


# ============================================================================
# Export / Import
# ============================================================================


@router.get("/stories/{story_id}/export", response_model=StoryExport)
async def export_story(
    story_id: UUID,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryExport:
    """Полный JSON-снапшот сюжета — для бэкапа и переноса между окружениями.

    Не включает: id, version, is_active, is_obsolete, timestamps. Всё это
    backend проставляет на импорте.
    """
    story = await _load_story_full(db, story_id)

    # Маппинг step_id → slug для transitions.
    slug_by_step_id: dict[UUID, str] = {s.id: s.slug for s in story.steps}

    steps_export = [
        StoryStepExport(
            slug=s.slug,
            kind=s.kind,
            label=s.label,
            payload=s.payload or {},
            position_x=s.position_x,
            position_y=s.position_y,
            cues=[
                StoryNarrationCueExport(
                    sort_order=c.sort_order,
                    trigger_slug=c.trigger.slug if c.trigger else None,
                    pause_before_ms=c.pause_before_ms,
                    pause_after_ms=c.pause_after_ms,
                    override_text=c.override_text,
                    override_duration_ms=c.override_duration_ms,
                )
                for c in sorted(s.cues, key=lambda x: x.sort_order)
            ],
        )
        for s in story.steps
    ]
    transitions_export = [
        StoryTransitionExport(
            from_slug=slug_by_step_id[t.from_step_id],
            to_slug=slug_by_step_id[t.to_step_id],
            condition=t.condition,
            priority=t.priority,
        )
        for t in story.transitions
    ]
    settings_export = (
        StorySettingsExport(
            inter_cue_pause_seconds=story.settings.inter_cue_pause_seconds,
            timer_multiplier_default=story.settings.timer_multiplier_default,
            karaoke_enabled=story.settings.karaoke_enabled,
        )
        if story.settings
        else StorySettingsExport()
    )
    entry_slug = (
        slug_by_step_id.get(story.entry_step_id) if story.entry_step_id else None
    )

    return StoryExport(
        slug=story.slug,
        name=story.name,
        description=story.description,
        entry_slug=entry_slug,
        settings=settings_export,
        steps=steps_export,
        transitions=transitions_export,
    )


@router.post(
    "/stories/import", response_model=StoryReadFull, status_code=201
)
async def import_story(
    request: StoryImportRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> StoryReadFull:
    """Импорт сюжета из JSON-снапшота (получен через ``GET .../export``).

    Слаги триггеров резолвятся через NarratorTrigger.slug. Пропавшие triggers
    логируются, cue остаётся text-only (override_text сохраняется как есть).

    Все step.slug'и должны быть уникальны в payload. Все transition.from_slug
    / to_slug должны существовать в steps. Если ``entry_slug`` задан, он тоже
    должен существовать.

    Создаётся новая Story с version=1, is_active=true.
    """
    payload = request.payload
    target_slug = request.override_slug or payload.slug
    await _ensure_unique_slug(db, target_slug)

    # Проверка уникальности step.slug в payload.
    seen_slugs: set[str] = set()
    for step in payload.steps:
        if step.slug in seen_slugs:
            raise GameError(
                422, "duplicate_step_slug",
                f"Step.slug={step.slug!r} встречается дважды в payload",
            )
        seen_slugs.add(step.slug)

    # Проверка transitions и entry.
    for t in payload.transitions:
        if t.from_slug not in seen_slugs:
            raise GameError(
                422, "transition_unknown_step",
                f"transition.from_slug={t.from_slug!r} не найден в steps",
            )
        if t.to_slug not in seen_slugs:
            raise GameError(
                422, "transition_unknown_step",
                f"transition.to_slug={t.to_slug!r} не найден в steps",
            )
        if t.from_slug == t.to_slug:
            raise GameError(
                422, "self_loop",
                f"transition {t.from_slug} → {t.to_slug}: from и to должны различаться",
            )
        # Валидация condition.
        _validate_condition(t.condition)

    if payload.entry_slug and payload.entry_slug not in seen_slugs:
        raise GameError(
            422, "invalid_entry_slug",
            f"entry_slug={payload.entry_slug!r} не найден в steps",
        )

    # Резолв триггеров.
    needed_trigger_slugs = {
        c.trigger_slug
        for s in payload.steps
        for c in s.cues
        if c.trigger_slug
    }
    trigger_id_by_slug: dict[str, UUID] = {}
    if needed_trigger_slugs:
        rows = (
            await db.scalars(
                select(NarratorTrigger).where(
                    NarratorTrigger.slug.in_(needed_trigger_slugs)
                )
            )
        ).all()
        trigger_id_by_slug = {r.slug: r.id for r in rows}
        missing = needed_trigger_slugs - trigger_id_by_slug.keys()
        if missing:
            log_event(
                logger, logging.WARNING, "story.import.missing_triggers",
                "Some trigger slugs from import payload not found in DB",
                missing_slugs=sorted(missing), story_slug=target_slug,
            )

    # Создаём Story.
    story = Story(
        id=uuid.uuid4(),
        slug=target_slug,
        version=1,
        name=payload.name,
        description=payload.description,
        is_active=True,
        is_obsolete=False,
    )
    db.add(story)
    db.add(
        StorySettings(
            story_id=story.id,
            inter_cue_pause_seconds=payload.settings.inter_cue_pause_seconds,
            timer_multiplier_default=payload.settings.timer_multiplier_default,
            karaoke_enabled=payload.settings.karaoke_enabled,
        )
    )

    step_id_by_slug: dict[str, UUID] = {}
    for step_def in payload.steps:
        new_step_id = uuid.uuid4()
        step_id_by_slug[step_def.slug] = new_step_id
        db.add(
            StoryStep(
                id=new_step_id,
                story_id=story.id,
                slug=step_def.slug,
                kind=step_def.kind,
                label=step_def.label,
                payload=step_def.payload,
                position_x=step_def.position_x,
                position_y=step_def.position_y,
            )
        )
    await db.flush()

    for step_def in payload.steps:
        for cue_def in step_def.cues:
            trig_id = (
                trigger_id_by_slug.get(cue_def.trigger_slug)
                if cue_def.trigger_slug
                else None
            )
            db.add(
                StoryNarrationCue(
                    id=uuid.uuid4(),
                    step_id=step_id_by_slug[step_def.slug],
                    sort_order=cue_def.sort_order,
                    trigger_id=trig_id,
                    pause_before_ms=cue_def.pause_before_ms,
                    pause_after_ms=cue_def.pause_after_ms,
                    override_text=cue_def.override_text,
                    override_duration_ms=cue_def.override_duration_ms,
                )
            )

    for t in payload.transitions:
        db.add(
            StoryTransition(
                id=uuid.uuid4(),
                story_id=story.id,
                from_step_id=step_id_by_slug[t.from_slug],
                to_step_id=step_id_by_slug[t.to_slug],
                condition=t.condition,
                priority=t.priority,
            )
        )

    if payload.entry_slug:
        story.entry_step_id = step_id_by_slug[payload.entry_slug]

    await db.commit()
    log_event(
        logger, logging.INFO, "story.imported",
        "Story imported", story_id=str(story.id), slug=story.slug,
        steps=len(payload.steps), transitions=len(payload.transitions),
        by_user=str(admin.id),
    )
    fresh = await _load_story_full(db, story.id)
    return _serialize_story_full(fresh)
