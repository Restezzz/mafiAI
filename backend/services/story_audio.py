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


def variant_index_for_cue(
    session_id: uuid.UUID | None, cue_id: uuid.UUID, variant_count: int
) -> int:
    """Детерминированно выбирает индекс варианта озвучки для (сессия, cue).

    Используется И при воспроизведении (``story_runtime``), И при предзагрузке
    (здесь), чтобы preload тянул ровно тот файл, который реально прозвучит —
    а не все варианты триггера. Стабильный sha1 вместо встроенного ``hash()``
    (тот солится PYTHONHASHSEED и «плавает» между процессами).
    """
    if variant_count <= 0:
        return 0
    if session_id is None:
        return 0
    digest = hashlib.sha1(f"{session_id}:{cue_id}".encode("utf-8")).hexdigest()
    return int(digest, 16) % variant_count


async def collect_story_audio_urls(
    db: AsyncSession,
    story_ids: list[uuid.UUID],
    *,
    session_id: uuid.UUID | None = None,
) -> list[str]:
    """Уникальные ``/audio/...`` URL'ы, которые может проиграть сюжет(ы).

    Возвращается отсортированный список (детерминированно — чтобы версия-хеш
    была стабильной между клиентами и перезапусками).

    ``session_id`` задан → собираем минимальный set: для каждой narration-cue
    берём ТОЛЬКО тот вариант триггера, который реально прозвучит в этой сессии
    (тот же детерминированный выбор, что и в ``story_runtime``). Раньше тянулись
    ВСЕ варианты каждого триггера + composite-сегменты (которые story-движок
    вообще не проигрывает) — отсюда ~50 файлов вместо реальных 5–10.
    Без ``session_id`` — поведение прежнее (все варианты), на случай legacy-путей.
    """
    if not story_ids:
        return []

    urls: set[str] = set()

    # 1. Варианты озвучки триггеров, на которые ссылаются narration-cues сюжета.
    #    Грузим cue→trigger→variants и для каждой cue добавляем выбранный вариант
    #    (а при session_id=None — все, для обратной совместимости).
    cues = (
        await db.scalars(
            select(StoryNarrationCue)
            .join(StoryStep, StoryNarrationCue.step_id == StoryStep.id)
            .where(
                StoryStep.story_id.in_(story_ids),
                StoryNarrationCue.trigger_id.is_not(None),
            )
            .options(
                selectinload(StoryNarrationCue.trigger)
                .selectinload(NarratorTrigger.variants)
                .selectinload(NarratorVariant.audio_file)
            )
        )
    ).all()
    for cue in cues:
        trigger = cue.trigger
        if trigger is None:
            continue
        # Стабильный порядок вариантов (по id) — чтобы индекс совпал с
        # воспроизведением независимо от порядка, в котором их вернул драйвер.
        variants = sorted(trigger.variants, key=lambda v: str(v.id))
        if not variants:
            continue
        if session_id is not None:
            idx = variant_index_for_cue(session_id, cue.id, len(variants))
            chosen = [variants[idx]]
        else:
            chosen = variants
        for variant in chosen:
            if variant.audio_file is not None:
                urls.add(_audio_url(variant.audio_file.storage_path))

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
