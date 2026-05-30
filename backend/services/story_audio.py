"""Резолвер набора аудио для конкретного сюжета (story-scoped preload).

Предзагрузка на экране лобби раньше тянула весь глобальный
``audioManifest.json`` (озвучка дефолтного ведущего, ~80+ файлов), хотя
story-движок проигрывает только те mp3, что реально привязаны к сюжету:

- варианты/composite-сегменты триггеров, на которые ссылаются narration-cues
  сюжета (``StoryNarrationCue.trigger_id``);
- базовое произношение имён набора сюжета (``StoryName.base_audio_file``);
- варианты произношения имён (``StoryNameVariantAsset.audio_file``).

Здесь мы собираем именно этот минимальный набор URL'ов (``/audio/{storage_path}``),
чтобы фронт грузил только релевантную озвучку, а не весь каталог.
"""
from __future__ import annotations

import hashlib
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models.narrator import (
    NarratorCompositeSegment,
    NarratorCompositeTemplate,
    NarratorTrigger,
    NarratorVariant,
)
from models.story import (
    StoryName,
    StoryNameVariant,
    StoryNameVariantAsset,
    StoryNarrationCue,
    StoryStep,
)


def _audio_url(storage_path: str) -> str:
    return f"/audio/{storage_path}"


async def collect_story_audio_urls(
    db: AsyncSession, story_ids: list[uuid.UUID]
) -> list[str]:
    """Уникальные ``/audio/...`` URL'ы, которые может проиграть сюжет(ы).

    Возвращается отсортированный список (детерминированно — чтобы версия-хеш
    была стабильной между клиентами и перезапусками).
    """
    if not story_ids:
        return []

    urls: set[str] = set()

    # 1. Триггеры, на которые ссылаются narration-cues сюжета: их варианты и
    #    composite-сегменты с привязанным audio_file.
    trigger_ids = set(
        (
            await db.scalars(
                select(StoryNarrationCue.trigger_id)
                .join(StoryStep, StoryNarrationCue.step_id == StoryStep.id)
                .where(
                    StoryStep.story_id.in_(story_ids),
                    StoryNarrationCue.trigger_id.is_not(None),
                )
            )
        ).all()
    )
    if trigger_ids:
        triggers = (
            await db.scalars(
                select(NarratorTrigger)
                .where(NarratorTrigger.id.in_(trigger_ids))
                .options(
                    selectinload(NarratorTrigger.variants).selectinload(
                        NarratorVariant.audio_file
                    ),
                    selectinload(NarratorTrigger.composite_templates)
                    .selectinload(NarratorCompositeTemplate.segments)
                    .selectinload(NarratorCompositeSegment.audio_file),
                )
            )
        ).all()
        for trigger in triggers:
            for variant in trigger.variants:
                if variant.audio_file is not None:
                    urls.add(_audio_url(variant.audio_file.storage_path))
            for template in trigger.composite_templates:
                for segment in template.segments:
                    if segment.audio_file is not None:
                        urls.add(_audio_url(segment.audio_file.storage_path))

    # 2. Базовое произношение имён набора сюжета.
    names = (
        await db.scalars(
            select(StoryName)
            .where(StoryName.story_id.in_(story_ids))
            .options(selectinload(StoryName.base_audio_file))
        )
    ).all()
    for name in names:
        if name.base_audio_file is not None:
            urls.add(_audio_url(name.base_audio_file.storage_path))

    # 3. Варианты произношения имён (фича 1).
    assets = (
        await db.scalars(
            select(StoryNameVariantAsset)
            .join(
                StoryNameVariant,
                StoryNameVariantAsset.variant_id == StoryNameVariant.id,
            )
            .where(
                StoryNameVariant.story_id.in_(story_ids),
                StoryNameVariantAsset.audio_file_id.is_not(None),
            )
            .options(selectinload(StoryNameVariantAsset.audio_file))
        )
    ).all()
    for asset in assets:
        if asset.audio_file is not None:
            urls.add(_audio_url(asset.audio_file.storage_path))

    return sorted(urls)


def story_audio_version(urls: list[str]) -> str:
    """Стабильная версия-хеш набора URL'ов.

    Меняется при любом изменении состава озвучки сюжета — readiness-карта
    игроков с устаревшей версией сбрасывается (см. ``_ready_map``), как и для
    глобального манифеста.
    """
    digest = hashlib.sha1("\n".join(urls).encode("utf-8")).hexdigest()
    return f"story-{digest[:12]}"
