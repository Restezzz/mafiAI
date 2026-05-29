"""Admin endpoints для narrator-системы.

Все эндпоинты гейтированы ``require_admin``. Содержит:
- READ: список/детали триггеров, audio-файлов, name-assets, placeholders.
- WRITE (Commit 7+): multipart upload + delete audio-файлов.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.deps import get_db, require_admin
from core.exceptions import GameError
from models.narrator import (
    NarratorAudioFile,
    NarratorCompositeSegment,
    NarratorCompositeTemplate,
    NarratorNameAsset,
    NarratorTrigger,
    NarratorVariant,
)
from models.story import Story
from models.user import User
from schemas.narrator import (
    AudioFileResponse,
    AudioFilesListResponse,
    CompositeSegmentCreate,
    CompositeSegmentResponse,
    CompositeSegmentUpdate,
    CompositeTemplateCreate,
    CompositeTemplateResponse,
    CompositeTemplateUpdate,
    NameAssetResponse,
    NameAssetsListResponse,
    NameAssetUpdate,
    PlaceholderInfo,
    PlaceholdersListResponse,
    TriggerCreate,
    TriggerResponse,
    TriggersListResponse,
    TriggerUpdate,
    VariantCreate,
    VariantResponse,
    VariantUpdate,
)
from services.narrator_audio_storage import delete_storage_file, save_uploaded_mp3
from services.narrator_placeholders import get_placeholder_catalog, is_known_placeholder
from services.narrator_slug import slugify_display_name


logger = logging.getLogger(__name__)


router = APIRouter()


# ---------------------------------------------------------------------------
# Serialization helpers (ORM → Pydantic)
# ---------------------------------------------------------------------------


def _audio_url(audio_file: NarratorAudioFile | None) -> str | None:
    """Готовый URL mp3 через StaticFiles mount.

    Совпадает с маунтом в main.py: app.mount('/audio', StaticFiles(...)).
    """
    if audio_file is None:
        return None
    return f"/audio/{audio_file.storage_path}"


def _serialize_audio_file(af: NarratorAudioFile) -> AudioFileResponse:
    return AudioFileResponse(
        id=str(af.id),
        filename=af.filename,
        url=_audio_url(af) or "",
        duration_ms=af.duration_ms,
        size_bytes=af.size_bytes,
        uploaded_at=af.uploaded_at,
        uploaded_by_id=str(af.uploaded_by_id) if af.uploaded_by_id else None,
    )


def _serialize_variant(v: NarratorVariant) -> VariantResponse:
    return VariantResponse(
        id=str(v.id),
        audio_file_id=str(v.audio_file_id) if v.audio_file_id else None,
        audio_url=_audio_url(v.audio_file),
        audio_filename=v.audio_file.filename if v.audio_file else None,
        text=v.text,
        duration_ms=v.duration_ms,
        sort_order=v.sort_order,
    )


def _serialize_segment(s: NarratorCompositeSegment) -> CompositeSegmentResponse:
    return CompositeSegmentResponse(
        id=str(s.id),
        position=s.position,
        kind=s.kind,  # type: ignore[arg-type]
        audio_file_id=str(s.audio_file_id) if s.audio_file_id else None,
        audio_url=_audio_url(s.audio_file),
        placeholder_key=s.placeholder_key,
        text_fragment=s.text_fragment,
    )


def _serialize_template(t: NarratorCompositeTemplate) -> CompositeTemplateResponse:
    return CompositeTemplateResponse(
        id=str(t.id),
        label=t.label,
        sort_order=t.sort_order,
        segments=[_serialize_segment(s) for s in t.segments],
    )


def _serialize_trigger(t: NarratorTrigger) -> TriggerResponse:
    return TriggerResponse(
        id=str(t.id),
        slug=t.slug,
        story_id=str(t.story_id) if t.story_id else None,
        group_key=t.group_key,
        label=t.label,
        description=t.description,
        kind=t.kind,  # type: ignore[arg-type]
        created_at=t.created_at,
        updated_at=t.updated_at,
        variants=[_serialize_variant(v) for v in t.variants],
        composite_templates=[_serialize_template(ct) for ct in t.composite_templates],
    )


def _serialize_name_asset(n: NarratorNameAsset) -> NameAssetResponse:
    return NameAssetResponse(
        id=str(n.id),
        display_name=n.display_name,
        slug=n.slug,
        gender=n.gender,  # type: ignore[arg-type]
        audio_file_id=str(n.audio_file_id),
        audio_url=_audio_url(n.audio_file) or "",
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/triggers", response_model=TriggersListResponse)
async def list_triggers(
    story_id: uuid.UUID | None = Query(
        default=None,
        description="Фильтр по сюжету. Без включенного include_global возвращает только триггеры этого сюжета.",
    ),
    include_global: bool = Query(
        default=False,
        description="Если True и задан story_id — в ответе также будут global-триггеры (story_id IS NULL).",
    ),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> TriggersListResponse:
    """Список триггеров с variants и composite_templates.

    Комбинации фильтров (story-scoped triggers, этап 6.6):
    - без параметров → все триггеры (легаси поведение).
    - ``?story_id=X`` → только триггеры этого сюжета.
    - ``?story_id=X&include_global=true`` → триггеры этого сюжета
      + global (story_id IS NULL). Этот вариант использует
      CueListEditor при ``Story.use_only_own_triggers=False``.
    - ``?include_global=true`` (без story_id) → только global.

    Eager-load всю иерархию (variants -> audio_file, templates -> segments -> audio_file)
    одним запросом через selectinload — N+1 был бы убийствен для админ-страницы.
    """
    stmt = (
        select(NarratorTrigger)
        .options(
            selectinload(NarratorTrigger.variants).selectinload(NarratorVariant.audio_file),
            selectinload(NarratorTrigger.composite_templates)
            .selectinload(NarratorCompositeTemplate.segments)
            .selectinload(NarratorCompositeSegment.audio_file),
        )
        .order_by(NarratorTrigger.group_key, NarratorTrigger.slug)
    )
    if story_id is not None and include_global:
        stmt = stmt.where(
            or_(
                NarratorTrigger.story_id == story_id,
                NarratorTrigger.story_id.is_(None),
            )
        )
    elif story_id is not None:
        stmt = stmt.where(NarratorTrigger.story_id == story_id)
    elif include_global:
        stmt = stmt.where(NarratorTrigger.story_id.is_(None))

    triggers = (await db.scalars(stmt)).all()
    return TriggersListResponse(triggers=[_serialize_trigger(t) for t in triggers])


@router.get("/triggers/{trigger_id}", response_model=TriggerResponse)
async def get_trigger(
    trigger_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> TriggerResponse:
    stmt = (
        select(NarratorTrigger)
        .where(NarratorTrigger.id == trigger_id)
        .options(
            selectinload(NarratorTrigger.variants).selectinload(NarratorVariant.audio_file),
            selectinload(NarratorTrigger.composite_templates)
            .selectinload(NarratorCompositeTemplate.segments)
            .selectinload(NarratorCompositeSegment.audio_file),
        )
    )
    trigger = await db.scalar(stmt)
    if trigger is None:
        raise GameError(404, "trigger_not_found", "Триггер не найден")
    return _serialize_trigger(trigger)


# ---------------------------------------------------------------------------
# Triggers CRUD
# ---------------------------------------------------------------------------


async def _load_trigger_with_children(
    db: AsyncSession, trigger_id: uuid.UUID
) -> NarratorTrigger:
    stmt = (
        select(NarratorTrigger)
        .where(NarratorTrigger.id == trigger_id)
        .options(
            selectinload(NarratorTrigger.variants).selectinload(NarratorVariant.audio_file),
            selectinload(NarratorTrigger.composite_templates)
            .selectinload(NarratorCompositeTemplate.segments)
            .selectinload(NarratorCompositeSegment.audio_file),
        )
    )
    trigger = await db.scalar(stmt)
    if trigger is None:
        raise GameError(404, "trigger_not_found", "Триггер не найден")
    return trigger


@router.post(
    "/triggers",
    response_model=TriggerResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_trigger(
    payload: TriggerCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> TriggerResponse:
    """Создаёт новый триггер.

    Скоуп-ориентированная уникальность slug:
    - ``story_id=None`` (global): проверяем что нет другого
      global-триггера с таким же slug.
    - ``story_id=<uuid>``: проверяем что такой сюжет существует
      и в нём нет другого триггера с таким же slug.
      Столкнуть global с story-scoped slug='foo' можно — это
      разрешёно по дизайну (сюжет затеняет global).
    """
    story_uuid: uuid.UUID | None = None
    if payload.story_id:
        try:
            story_uuid = uuid.UUID(payload.story_id)
        except ValueError as exc:
            raise GameError(400, "invalid_story_id", "story_id должен быть UUID") from exc
        story_exists = await db.scalar(
            select(Story.id).where(Story.id == story_uuid)
        )
        if story_exists is None:
            raise GameError(404, "story_not_found", "Сюжет не найден")

    existing = await db.scalar(
        select(NarratorTrigger).where(
            NarratorTrigger.slug == payload.slug,
            NarratorTrigger.story_id.is_(None)
            if story_uuid is None
            else NarratorTrigger.story_id == story_uuid,
        )
    )
    if existing is not None:
        scope_msg = "в этом сюжете" if story_uuid else "в global-namespace"
        raise GameError(
            409,
            "trigger_slug_conflict",
            f"Триггер со slug {payload.slug!r} уже существует {scope_msg}",
        )

    trigger = NarratorTrigger(
        id=uuid.uuid4(),
        slug=payload.slug,
        story_id=story_uuid,
        group_key=payload.group_key,
        label=payload.label,
        description=payload.description,
        kind=payload.kind,
    )
    db.add(trigger)
    await db.commit()
    logger.info(
        "narrator.trigger.created slug=%s kind=%s story_id=%s by_user=%s",
        payload.slug,
        payload.kind,
        story_uuid,
        admin.id,
    )
    return _serialize_trigger(await _load_trigger_with_children(db, trigger.id))


@router.put("/triggers/{trigger_id}", response_model=TriggerResponse)
async def update_trigger(
    trigger_id: uuid.UUID,
    payload: TriggerUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> TriggerResponse:
    """Обновляет ``group_key`` / ``label`` / ``description``. ``slug`` и ``kind``
    неизменяемы (любая из этих смен требует пересоздания триггера).
    """
    trigger = await db.get(NarratorTrigger, trigger_id)
    if trigger is None:
        raise GameError(404, "trigger_not_found", "Триггер не найден")

    if payload.group_key is not None:
        trigger.group_key = payload.group_key
    if payload.label is not None:
        trigger.label = payload.label
    if payload.description is not None:
        trigger.description = payload.description

    await db.commit()
    logger.info("narrator.trigger.updated id=%s by_user=%s", trigger_id, admin.id)
    return _serialize_trigger(await _load_trigger_with_children(db, trigger_id))


@router.delete("/triggers/{trigger_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_trigger(
    trigger_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Удаляет триггер. Каскадно удаляются variants / composite_templates /
    composite_segments (см. ondelete='CASCADE' в моделях). ``NarratorAudioFile``
    при этом не трогается — на физические mp3 ссылается отдельная сущность.
    """
    trigger = await db.get(NarratorTrigger, trigger_id)
    if trigger is None:
        raise GameError(404, "trigger_not_found", "Триггер не найден")
    await db.delete(trigger)
    await db.commit()
    logger.info("narrator.trigger.deleted id=%s by_user=%s", trigger_id, admin.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Variants CRUD (для kind='variant' триггеров)
# ---------------------------------------------------------------------------


async def _require_variant_trigger(
    db: AsyncSession, trigger_id: uuid.UUID
) -> NarratorTrigger:
    trigger = await db.get(NarratorTrigger, trigger_id)
    if trigger is None:
        raise GameError(404, "trigger_not_found", "Триггер не найден")
    if trigger.kind != "variant":
        raise GameError(
            400,
            "trigger_kind_mismatch",
            f"Triggers с kind={trigger.kind!r} не поддерживают variants — используйте composite_templates",
        )
    return trigger


async def _resolve_audio_file_id(
    db: AsyncSession, audio_file_id: str | None
) -> uuid.UUID | None:
    """Парсит строковый UUID + проверяет существование. None → None."""
    if audio_file_id is None or audio_file_id == "":
        return None
    try:
        parsed = uuid.UUID(audio_file_id)
    except (ValueError, AttributeError) as exc:
        raise GameError(400, "invalid_audio_file_id", "audio_file_id должен быть UUID") from exc
    af = await db.get(NarratorAudioFile, parsed)
    if af is None:
        raise GameError(404, "audio_not_found", "Аудио-файл не найден")
    return parsed


@router.post(
    "/triggers/{trigger_id}/variants",
    response_model=VariantResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_variant(
    trigger_id: uuid.UUID,
    payload: VariantCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> VariantResponse:
    """Создаёт вариант для variant-триггера."""
    trigger = await _require_variant_trigger(db, trigger_id)
    audio_uuid = await _resolve_audio_file_id(db, payload.audio_file_id)

    variant = NarratorVariant(
        id=uuid.uuid4(),
        trigger_id=trigger.id,
        audio_file_id=audio_uuid,
        text=payload.text,
        duration_ms=payload.duration_ms,
        sort_order=payload.sort_order,
    )
    db.add(variant)
    await db.commit()
    # Re-fetch для eager-load audio_file.
    stmt = (
        select(NarratorVariant)
        .where(NarratorVariant.id == variant.id)
        .options(selectinload(NarratorVariant.audio_file))
    )
    fresh = await db.scalar(stmt)
    logger.info(
        "narrator.variant.created id=%s trigger_id=%s by_user=%s",
        variant.id,
        trigger_id,
        admin.id,
    )
    return _serialize_variant(fresh)  # type: ignore[arg-type]


@router.put("/variants/{variant_id}", response_model=VariantResponse)
async def update_variant(
    variant_id: uuid.UUID,
    payload: VariantUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> VariantResponse:
    variant = await db.get(NarratorVariant, variant_id)
    if variant is None:
        raise GameError(404, "variant_not_found", "Вариант не найден")

    if payload.text is not None:
        variant.text = payload.text
    if payload.duration_ms is not None:
        variant.duration_ms = payload.duration_ms
    if payload.sort_order is not None:
        variant.sort_order = payload.sort_order

    if payload.unset_audio:
        variant.audio_file_id = None
    elif payload.audio_file_id is not None:
        # Пустая строка тоже означает сброс (UI-удобство).
        if payload.audio_file_id == "":
            variant.audio_file_id = None
        else:
            variant.audio_file_id = await _resolve_audio_file_id(db, payload.audio_file_id)

    await db.commit()
    stmt = (
        select(NarratorVariant)
        .where(NarratorVariant.id == variant.id)
        .options(selectinload(NarratorVariant.audio_file))
    )
    fresh = await db.scalar(stmt)
    logger.info("narrator.variant.updated id=%s by_user=%s", variant_id, admin.id)
    return _serialize_variant(fresh)  # type: ignore[arg-type]


@router.delete("/variants/{variant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_variant(
    variant_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    variant = await db.get(NarratorVariant, variant_id)
    if variant is None:
        raise GameError(404, "variant_not_found", "Вариант не найден")
    await db.delete(variant)
    await db.commit()
    logger.info("narrator.variant.deleted id=%s by_user=%s", variant_id, admin.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Composite templates + segments CRUD (для kind='composite' триггеров)
# ---------------------------------------------------------------------------


async def _require_composite_trigger(
    db: AsyncSession, trigger_id: uuid.UUID
) -> NarratorTrigger:
    trigger = await db.get(NarratorTrigger, trigger_id)
    if trigger is None:
        raise GameError(404, "trigger_not_found", "Триггер не найден")
    if trigger.kind != "composite":
        raise GameError(
            400,
            "trigger_kind_mismatch",
            f"Triggers с kind={trigger.kind!r} не поддерживают composite_templates — используйте variants",
        )
    return trigger


async def _load_template_with_segments(
    db: AsyncSession, template_id: uuid.UUID
) -> NarratorCompositeTemplate:
    stmt = (
        select(NarratorCompositeTemplate)
        .where(NarratorCompositeTemplate.id == template_id)
        .options(
            selectinload(NarratorCompositeTemplate.segments).selectinload(
                NarratorCompositeSegment.audio_file
            )
        )
    )
    template = await db.scalar(stmt)
    if template is None:
        raise GameError(404, "template_not_found", "Шаблон не найден")
    return template


def _validate_segment_invariants(
    *,
    kind: str,
    audio_file_id: uuid.UUID | None,
    placeholder_key: str | None,
) -> None:
    """Проверяет согласованность kind <-> {audio_file_id, placeholder_key}.

    Срабатывает и при create, и при update (после применения частичного апдейта).
    """
    if kind == "audio":
        if audio_file_id is None:
            raise GameError(
                400, "segment_audio_required", "Сегмент kind='audio' требует audio_file_id"
            )
        if placeholder_key is not None:
            raise GameError(
                400,
                "segment_audio_no_placeholder",
                "Сегмент kind='audio' не должен иметь placeholder_key",
            )
    elif kind == "placeholder":
        if placeholder_key is None:
            raise GameError(
                400,
                "segment_placeholder_required",
                "Сегмент kind='placeholder' требует placeholder_key",
            )
        if not is_known_placeholder(placeholder_key):
            raise GameError(
                400,
                "placeholder_unknown",
                f"placeholder_key={placeholder_key!r} отсутствует в catalog. См. /api/admin/narrator/placeholders",
            )
        if audio_file_id is not None:
            raise GameError(
                400,
                "segment_placeholder_no_audio",
                "Сегмент kind='placeholder' не должен иметь audio_file_id",
            )
    else:
        raise GameError(400, "segment_kind_invalid", f"Недопустимый kind={kind!r}")


@router.post(
    "/triggers/{trigger_id}/composite-templates",
    response_model=CompositeTemplateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_composite_template(
    trigger_id: uuid.UUID,
    payload: CompositeTemplateCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CompositeTemplateResponse:
    trigger = await _require_composite_trigger(db, trigger_id)
    template = NarratorCompositeTemplate(
        id=uuid.uuid4(),
        trigger_id=trigger.id,
        label=payload.label,
        sort_order=payload.sort_order,
    )
    db.add(template)
    await db.commit()
    logger.info(
        "narrator.template.created id=%s trigger_id=%s by_user=%s",
        template.id,
        trigger_id,
        admin.id,
    )
    return _serialize_template(await _load_template_with_segments(db, template.id))


@router.put(
    "/composite-templates/{template_id}",
    response_model=CompositeTemplateResponse,
)
async def update_composite_template(
    template_id: uuid.UUID,
    payload: CompositeTemplateUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CompositeTemplateResponse:
    template = await db.get(NarratorCompositeTemplate, template_id)
    if template is None:
        raise GameError(404, "template_not_found", "Шаблон не найден")
    if payload.label is not None:
        template.label = payload.label
    if payload.sort_order is not None:
        template.sort_order = payload.sort_order
    await db.commit()
    logger.info("narrator.template.updated id=%s by_user=%s", template_id, admin.id)
    return _serialize_template(await _load_template_with_segments(db, template_id))


@router.delete(
    "/composite-templates/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_composite_template(
    template_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    template = await db.get(NarratorCompositeTemplate, template_id)
    if template is None:
        raise GameError(404, "template_not_found", "Шаблон не найден")
    await db.delete(template)
    await db.commit()
    logger.info("narrator.template.deleted id=%s by_user=%s", template_id, admin.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/composite-templates/{template_id}/segments",
    response_model=CompositeSegmentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_composite_segment(
    template_id: uuid.UUID,
    payload: CompositeSegmentCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CompositeSegmentResponse:
    """Создаёт сегмент. Должен соблюдать инварианты kind <-> поля.

    Уникальность ``(template_id, position)`` гарантируется БД-констрэинтом
    ``uq_narrator_segments_template_pos`` — на конфликте вернём 409.
    """
    template = await db.get(NarratorCompositeTemplate, template_id)
    if template is None:
        raise GameError(404, "template_not_found", "Шаблон не найден")

    audio_uuid = await _resolve_audio_file_id(db, payload.audio_file_id)
    _validate_segment_invariants(
        kind=payload.kind,
        audio_file_id=audio_uuid,
        placeholder_key=payload.placeholder_key,
    )

    # Защита от дубликата (template_id, position) — лаконичнее, чем ловить IntegrityError.
    conflict = await db.scalar(
        select(NarratorCompositeSegment).where(
            NarratorCompositeSegment.template_id == template_id,
            NarratorCompositeSegment.position == payload.position,
        )
    )
    if conflict is not None:
        raise GameError(
            409,
            "segment_position_conflict",
            f"В шаблоне уже есть сегмент с position={payload.position}",
        )

    segment = NarratorCompositeSegment(
        id=uuid.uuid4(),
        template_id=template_id,
        position=payload.position,
        kind=payload.kind,
        audio_file_id=audio_uuid,
        placeholder_key=payload.placeholder_key,
        text_fragment=payload.text_fragment,
    )
    db.add(segment)
    await db.commit()
    stmt = (
        select(NarratorCompositeSegment)
        .where(NarratorCompositeSegment.id == segment.id)
        .options(selectinload(NarratorCompositeSegment.audio_file))
    )
    fresh = await db.scalar(stmt)
    logger.info(
        "narrator.segment.created id=%s template_id=%s by_user=%s",
        segment.id,
        template_id,
        admin.id,
    )
    return _serialize_segment(fresh)  # type: ignore[arg-type]


@router.put("/segments/{segment_id}", response_model=CompositeSegmentResponse)
async def update_composite_segment(
    segment_id: uuid.UUID,
    payload: CompositeSegmentUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CompositeSegmentResponse:
    segment = await db.get(NarratorCompositeSegment, segment_id)
    if segment is None:
        raise GameError(404, "segment_not_found", "Сегмент не найден")

    # Применяем апдейт временно в локальных переменных, валидируем, потом сохраняем.
    new_kind = payload.kind if payload.kind is not None else segment.kind
    new_position = payload.position if payload.position is not None else segment.position
    new_text = payload.text_fragment if payload.text_fragment is not None else segment.text_fragment

    if payload.unset_audio:
        new_audio_id: uuid.UUID | None = None
    elif payload.audio_file_id is not None:
        new_audio_id = (
            None
            if payload.audio_file_id == ""
            else await _resolve_audio_file_id(db, payload.audio_file_id)
        )
    else:
        new_audio_id = segment.audio_file_id

    # placeholder_key: None в payload = "не менять"; "" = сбросить.
    if payload.placeholder_key is None:
        new_placeholder: str | None = segment.placeholder_key
    elif payload.placeholder_key == "":
        new_placeholder = None
    else:
        new_placeholder = payload.placeholder_key

    _validate_segment_invariants(
        kind=new_kind, audio_file_id=new_audio_id, placeholder_key=new_placeholder
    )

    # Проверим уникальность position, если она меняется.
    if new_position != segment.position:
        conflict = await db.scalar(
            select(NarratorCompositeSegment).where(
                NarratorCompositeSegment.template_id == segment.template_id,
                NarratorCompositeSegment.position == new_position,
                NarratorCompositeSegment.id != segment.id,
            )
        )
        if conflict is not None:
            raise GameError(
                409,
                "segment_position_conflict",
                f"В шаблоне уже есть сегмент с position={new_position}",
            )

    segment.kind = new_kind
    segment.position = new_position
    segment.text_fragment = new_text
    segment.audio_file_id = new_audio_id
    segment.placeholder_key = new_placeholder

    await db.commit()
    stmt = (
        select(NarratorCompositeSegment)
        .where(NarratorCompositeSegment.id == segment.id)
        .options(selectinload(NarratorCompositeSegment.audio_file))
    )
    fresh = await db.scalar(stmt)
    logger.info("narrator.segment.updated id=%s by_user=%s", segment_id, admin.id)
    return _serialize_segment(fresh)  # type: ignore[arg-type]


@router.delete("/segments/{segment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_composite_segment(
    segment_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    segment = await db.get(NarratorCompositeSegment, segment_id)
    if segment is None:
        raise GameError(404, "segment_not_found", "Сегмент не найден")
    await db.delete(segment)
    await db.commit()
    logger.info("narrator.segment.deleted id=%s by_user=%s", segment_id, admin.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/audio-files", response_model=AudioFilesListResponse)
async def list_audio_files(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AudioFilesListResponse:
    stmt = select(NarratorAudioFile).order_by(NarratorAudioFile.filename)
    files = (await db.scalars(stmt)).all()
    return AudioFilesListResponse(audio_files=[_serialize_audio_file(f) for f in files])


# Whitelist content-types для multipart upload.
# Поддерживаем mp3, wav, ogg, flac, m4a и generic fallback.
_ALLOWED_AUDIO_CONTENT_TYPES = {
    "audio/mpeg", "audio/mp3",          # mp3
    "audio/wav", "audio/x-wav", "audio/wave",  # wav
    "audio/ogg", "audio/vorbis",        # ogg
    "audio/flac", "audio/x-flac",       # flac
    "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",  # m4a/aac
    "application/octet-stream",         # generic fallback
}
# Максимальный размер аудио (10 MB) — narrator-фразы короткие, защищаем диск.
_MAX_MP3_BYTES = 10 * 1024 * 1024


@router.post(
    "/audio-files",
    response_model=AudioFileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_audio_file(
    file: UploadFile = File(..., description="mp3 файл"),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AudioFileResponse:
    """Загружает mp3, извлекает duration через mutagen и создаёт NarratorAudioFile.

    Имя файла на диске — uuid.mp3 (исключает path-traversal и конфликты).
    Оригинальное ``filename`` хранится в БД и должен быть уникальным —
    при дубликате возвращаем 409.
    """
    if file.filename is None:
        raise GameError(400, "filename_missing", "Не указано имя файла")
    if file.content_type not in _ALLOWED_AUDIO_CONTENT_TYPES:
        raise GameError(415, "unsupported_media_type", f"Ожидается аудио файл, получено {file.content_type!r}")

    filename = file.filename.strip()
    if not filename:
        raise GameError(400, "filename_empty", "Имя файла пустое")

    # Проверяем уникальность filename ДО записи на диск.
    existing = await db.scalar(
        select(NarratorAudioFile).where(NarratorAudioFile.filename == filename)
    )
    if existing is not None:
        raise GameError(
            409,
            "audio_filename_conflict",
            f"Файл с именем {filename!r} уже существует. Сначала удалите старый.",
        )

    # Проверка размера до полной записи (если client передал content-length).
    if file.size is not None and file.size > _MAX_MP3_BYTES:
        raise GameError(
            413,
            "file_too_large",
            f"Размер mp3 превышает {_MAX_MP3_BYTES // (1024 * 1024)} MB",
        )

    audio_id = uuid.uuid4()
    storage_path, duration_ms, size_bytes = await save_uploaded_mp3(
        audio_id=audio_id, source=file.file
    )
    if size_bytes > _MAX_MP3_BYTES:
        # Подчищаем за собой и отказываем.
        delete_storage_file(storage_path)
        raise GameError(
            413,
            "file_too_large",
            f"Размер mp3 превышает {_MAX_MP3_BYTES // (1024 * 1024)} MB",
        )

    audio = NarratorAudioFile(
        id=audio_id,
        filename=filename,
        storage_path=storage_path,
        duration_ms=duration_ms,
        size_bytes=size_bytes,
        uploaded_by_id=admin.id,
    )
    db.add(audio)
    await db.commit()
    await db.refresh(audio)
    logger.info(
        "narrator.audio.uploaded id=%s filename=%s by_user=%s",
        audio.id,
        filename,
        admin.id,
    )
    return _serialize_audio_file(audio)


@router.delete("/audio-files/{audio_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_audio_file(
    audio_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Удаляет ``NarratorAudioFile`` и связанный mp3 на диске.

    Запрещено удалять, если файл используется в ``NarratorNameAsset`` (FK
    RESTRICT в модели). variants/segments автоматически получают NULL
    через ondelete='SET NULL'.
    """
    audio = await db.get(NarratorAudioFile, audio_id)
    if audio is None:
        raise GameError(404, "audio_not_found", "Аудио-файл не найден")

    # name_assets имеют FK с RESTRICT — проверяем заранее, чтобы вернуть
    # понятный 409 вместо непрозрачной БД-ошибки.
    in_use = await db.scalar(
        select(func.count(NarratorNameAsset.id)).where(
            NarratorNameAsset.audio_file_id == audio_id
        )
    )
    if in_use:
        raise GameError(
            409,
            "audio_in_use",
            f"Файл используется в {in_use} name-asset(ах). Сначала удалите/переназначьте их.",
        )

    storage_path = audio.storage_path
    await db.delete(audio)
    await db.commit()
    delete_storage_file(storage_path)
    logger.info("narrator.audio.deleted id=%s path=%s", audio_id, storage_path)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/name-assets", response_model=NameAssetsListResponse)
async def list_name_assets(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> NameAssetsListResponse:
    stmt = (
        select(NarratorNameAsset)
        .options(selectinload(NarratorNameAsset.audio_file))
        .order_by(NarratorNameAsset.display_name)
    )
    assets = (await db.scalars(stmt)).all()
    return NameAssetsListResponse(name_assets=[_serialize_name_asset(a) for a in assets])


async def _load_name_asset(db: AsyncSession, name_id: uuid.UUID) -> NarratorNameAsset:
    stmt = (
        select(NarratorNameAsset)
        .where(NarratorNameAsset.id == name_id)
        .options(selectinload(NarratorNameAsset.audio_file))
    )
    asset = await db.scalar(stmt)
    if asset is None:
        raise GameError(404, "name_not_found", "Имя не найдено")
    return asset


@router.post(
    "/name-assets",
    response_model=NameAssetResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_name_asset(
    display_name: str = Form(..., min_length=1, max_length=60),
    gender: str = Form(..., pattern="^[mf]$"),
    file: UploadFile = File(..., description="mp3 произношения имени"),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> NameAssetResponse:
    """Создаёт ``NarratorNameAsset`` + загружает mp3.

    ``slug`` авто-генерируется из ``display_name`` (транслит + lowercase).
    Slug и display_name должны быть уникальны.
    """
    if file.content_type not in _ALLOWED_MP3_CONTENT_TYPES:
        raise GameError(
            415, "unsupported_media_type", f"Ожидается mp3, получено {file.content_type!r}"
        )

    display_name = display_name.strip()
    slug = slugify_display_name(display_name)
    if not slug:
        raise GameError(
            400,
            "name_slug_empty",
            "Не удалось сгенерировать slug из display_name (используйте кириллицу или латиницу)",
        )

    if await db.scalar(
        select(NarratorNameAsset).where(NarratorNameAsset.display_name == display_name)
    ):
        raise GameError(
            409, "name_display_conflict", f"Имя {display_name!r} уже существует"
        )
    if await db.scalar(select(NarratorNameAsset).where(NarratorNameAsset.slug == slug)):
        raise GameError(
            409,
            "name_slug_conflict",
            f"Slug {slug!r} уже занят. Возможно есть имя с похожим написанием.",
        )

    if file.size is not None and file.size > _MAX_MP3_BYTES:
        raise GameError(
            413, "file_too_large", f"Размер mp3 превышает {_MAX_MP3_BYTES // (1024 * 1024)} MB"
        )

    audio_id = uuid.uuid4()
    storage_path, duration_ms, size_bytes = await save_uploaded_mp3(
        audio_id=audio_id, source=file.file
    )
    if size_bytes > _MAX_MP3_BYTES:
        delete_storage_file(storage_path)
        raise GameError(
            413, "file_too_large", f"Размер mp3 превышает {_MAX_MP3_BYTES // (1024 * 1024)} MB"
        )

    # Filename в БД — имя загруженного файла; добавим суффикс с slug'ом для опознавания
    # в списке audio-файлов админки.
    audio_filename = file.filename or f"name_{slug}.mp3"
    # Гарантируем уникальность filename (на случай если админ повторно загружает с тем же
    # именем файла). filename мы используем чисто для админ-отображения, поэтому добавим slug.
    audio_filename = f"name_{slug}__{audio_filename}".strip()

    audio = NarratorAudioFile(
        id=audio_id,
        filename=audio_filename,
        storage_path=storage_path,
        duration_ms=duration_ms,
        size_bytes=size_bytes,
        uploaded_by_id=admin.id,
    )
    asset = NarratorNameAsset(
        id=uuid.uuid4(),
        display_name=display_name,
        slug=slug,
        gender=gender,
        audio_file_id=audio_id,
    )
    db.add(audio)
    db.add(asset)
    await db.commit()
    logger.info(
        "narrator.name.created id=%s slug=%s gender=%s by_user=%s",
        asset.id,
        slug,
        gender,
        admin.id,
    )
    return _serialize_name_asset(await _load_name_asset(db, asset.id))


@router.put("/name-assets/{name_id}", response_model=NameAssetResponse)
async def update_name_asset(
    name_id: uuid.UUID,
    payload: NameAssetUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> NameAssetResponse:
    """Обновляет ``display_name`` / ``gender`` / ``audio_file_id``.

    При смене ``display_name`` ``slug`` пересчитывается. Чтобы поменять
    mp3 — нужно либо передать ``audio_file_id`` существующего файла,
    либо отдельно: 1) POST /audio-files (получить новый id), 2) PUT name_asset.
    """
    asset = await db.get(NarratorNameAsset, name_id)
    if asset is None:
        raise GameError(404, "name_not_found", "Имя не найдено")

    if payload.display_name is not None:
        new_display = payload.display_name.strip()
        new_slug = slugify_display_name(new_display)
        if not new_slug:
            raise GameError(400, "name_slug_empty", "display_name даёт пустой slug")
        if new_display != asset.display_name and await db.scalar(
            select(NarratorNameAsset).where(
                NarratorNameAsset.display_name == new_display,
                NarratorNameAsset.id != name_id,
            )
        ):
            raise GameError(
                409, "name_display_conflict", f"Имя {new_display!r} уже существует"
            )
        if new_slug != asset.slug and await db.scalar(
            select(NarratorNameAsset).where(
                NarratorNameAsset.slug == new_slug,
                NarratorNameAsset.id != name_id,
            )
        ):
            raise GameError(409, "name_slug_conflict", f"Slug {new_slug!r} уже занят")
        asset.display_name = new_display
        asset.slug = new_slug

    if payload.gender is not None:
        asset.gender = payload.gender

    if payload.audio_file_id is not None:
        resolved = await _resolve_audio_file_id(db, payload.audio_file_id)
        if resolved is None:
            raise GameError(
                400, "name_audio_required", "audio_file_id не может быть пустым для имени"
            )
        asset.audio_file_id = resolved

    await db.commit()
    logger.info("narrator.name.updated id=%s by_user=%s", name_id, admin.id)
    return _serialize_name_asset(await _load_name_asset(db, name_id))


@router.delete("/name-assets/{name_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_name_asset(
    name_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Удаляет имя. Связанный mp3-файл удаляется тоже, если он не
    используется в variants/segments (т.е. был выделен для этого имени).
    """
    asset = await db.scalar(
        select(NarratorNameAsset)
        .where(NarratorNameAsset.id == name_id)
        .options(selectinload(NarratorNameAsset.audio_file))
    )
    if asset is None:
        raise GameError(404, "name_not_found", "Имя не найдено")

    audio_id = asset.audio_file_id
    audio_storage_path = asset.audio_file.storage_path if asset.audio_file else None
    await db.delete(asset)
    await db.flush()

    # Проверяем, не используется ли audio где-то ещё (variants/segments/прочие name_assets).
    used_in_variant = await db.scalar(
        select(func.count(NarratorVariant.id)).where(
            NarratorVariant.audio_file_id == audio_id
        )
    )
    used_in_segment = await db.scalar(
        select(func.count(NarratorCompositeSegment.id)).where(
            NarratorCompositeSegment.audio_file_id == audio_id
        )
    )
    used_in_name = await db.scalar(
        select(func.count(NarratorNameAsset.id)).where(
            NarratorNameAsset.audio_file_id == audio_id
        )
    )
    if not used_in_variant and not used_in_segment and not used_in_name:
        audio_row = await db.get(NarratorAudioFile, audio_id)
        if audio_row is not None:
            await db.delete(audio_row)

    await db.commit()
    if audio_storage_path and not used_in_variant and not used_in_segment and not used_in_name:
        delete_storage_file(audio_storage_path)
    logger.info("narrator.name.deleted id=%s by_user=%s", name_id, admin.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/placeholders", response_model=PlaceholdersListResponse)
async def list_placeholders(
    _admin: User = Depends(require_admin),
) -> PlaceholdersListResponse:
    """Статический каталог placeholder'ов из ``narrator_placeholders.py``.

    Не ходит в БД — placeholder'ы захардкожены, потому что их добавление
    требует кодовых изменений в резолвере game_engine.
    """
    catalog = get_placeholder_catalog()
    return PlaceholdersListResponse(
        placeholders=[
            PlaceholderInfo(key=p.key, label=p.label, description=p.description)
            for p in catalog
        ]
    )
