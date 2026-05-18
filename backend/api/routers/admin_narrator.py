"""Admin endpoints для narrator-системы (read-only в этом коммите).

Все эндпоинты гейтированы ``require_admin``. CRUD-операции (POST/PUT/DELETE)
+ multipart upload mp3 добавляются в последующих коммитах M3/M4.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
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
from models.user import User
from schemas.narrator import (
    AudioFileResponse,
    AudioFilesListResponse,
    CompositeSegmentResponse,
    CompositeTemplateResponse,
    NameAssetResponse,
    NameAssetsListResponse,
    PlaceholderInfo,
    PlaceholdersListResponse,
    TriggerResponse,
    TriggersListResponse,
    VariantResponse,
)
from services.narrator_placeholders import get_placeholder_catalog


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
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> TriggersListResponse:
    """Список всех триггеров с variants и composite_templates.

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


@router.get("/audio-files", response_model=AudioFilesListResponse)
async def list_audio_files(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AudioFilesListResponse:
    stmt = select(NarratorAudioFile).order_by(NarratorAudioFile.filename)
    files = (await db.scalars(stmt)).all()
    return AudioFilesListResponse(audio_files=[_serialize_audio_file(f) for f in files])


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
