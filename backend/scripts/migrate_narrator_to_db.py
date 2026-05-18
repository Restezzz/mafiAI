"""Migration script: populate narrator DB tables from audio_manifest.json.

Reads ``audio_manifest.json`` from the repo root and:
- Creates ``NarratorAudioFile`` entries for every referenced mp3 (skipped if already present by filename).
- Copies physical mp3 files from ``frontend/public/audio/`` to ``settings.AUDIO_STORAGE_ROOT``.
- Creates ``NarratorTrigger`` + ``NarratorVariant`` for each ``kind='variant'`` trigger.
- Creates ``NarratorTrigger(kind='composite')`` + ``NarratorCompositeTemplate`` (with 3 segments: audio
  + placeholder + audio) for each ``kind='name_pair'`` trigger.
- For ``one_killed`` (the only name_pair with female/male variants) splits into TWO triggers:
  ``one_killed_female`` (2 templates) and ``one_killed_male`` (6 templates). Game engine selects the
  trigger by victim gender.
- Creates ``NarratorNameAsset`` for each name in the manifest, with its own ``NarratorAudioFile``.

Idempotent: re-running skips records that already exist (matching by slug / filename).

Usage (from backend/ inside the container):

    docker compose exec backend .venv/bin/python scripts/migrate_narrator_to_db.py

Or locally with uv:

    cd backend && uv run python scripts/migrate_narrator_to_db.py

Optional flags:
    --manifest PATH      Path to audio_manifest.json (default: ../audio_manifest.json from backend/).
    --audio-src DIR      Source mp3 root (default: ../frontend/public/audio).
    --dry-run            Print what would be inserted/copied without touching DB or filesystem.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any

# Add backend root to sys.path so we can import models / core when invoked from anywhere.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.database import async_session_factory
from models.narrator import (
    NarratorAudioFile,
    NarratorCompositeSegment,
    NarratorCompositeTemplate,
    NarratorNameAsset,
    NarratorTrigger,
    NarratorVariant,
)


logger = logging.getLogger("migrate_narrator")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


# ---------------------------------------------------------------------------
# UI metadata for triggers (group_key + human label + description).
# Captured from narration_script.py call-sites + audio_manifest.json. Used by
# admin UI for grouping in sidebar / table headers.
# ---------------------------------------------------------------------------
TRIGGER_META: dict[str, tuple[str, str, str | None]] = {
    # Intro / rules
    "intro_poem": ("intro", "Вступительный стих", "Запускается в начале игры до раскрытия ролей."),
    "intro_personality": ("intro", "Вступление: личность", None),
    "rules": ("intro", "Объявление правил", None),
    # Night — mafia
    "mafia_eyes_open": ("night_mafia", "Мафия открывает глаза", None),
    "mafia_and_don_eyes_open": ("night_mafia", "Мафия и Дон открывают глаза", None),
    "mafia_exit_poem": ("night_mafia", "Выход мафии (стих)", None),
    "mafia_choose": ("night_mafia", "Мафия делает выбор", None),
    "mafia_choice_made": ("night_mafia", "Мафия сделала выбор", None),
    "mafia_eyes_close": ("night_mafia", "Мафия закрывает глаза", None),
    "mafia_eyes_close_don_chooses": (
        "night_mafia",
        "Мафия закрывает глаза, Дон выбирает",
        None,
    ),
    "don_eyes_close": ("night_mafia", "Дон закрывает глаза", None),
    # Night — doctor
    "doctor_eyes_open": ("night_doctor", "Доктор открывает глаза", None),
    "doctor_eyes_close": ("night_doctor", "Доктор закрывает глаза", None),
    # Night — sheriff
    "sheriff_wakes": ("night_sheriff", "Шериф просыпается", None),
    "sheriff_chooses": ("night_sheriff", "Шериф делает выбор", None),
    "sheriff_chose": ("night_sheriff", "Шериф сделал выбор", None),
    # Day
    "after_night_result": ("day", "После ночного результата", None),
    "no_one_killed_doctor": ("day", "Никто не убит (доктор спас)", None),
    "one_killed_female": (
        "day",
        "Один убитый: девушка",
        "Composite: opener + имя_игрока + closer. Подставляется при gender='f' жертвы.",
    ),
    "one_killed_male": (
        "day",
        "Один убитый: мужчина",
        "Composite: opener + имя_игрока + closer. Подставляется при gender='m' жертвы.",
    ),
    "after_discussion": ("day", "После обсуждения", None),
    "no_accuse": ("day", "Никто не обвинён", None),
    "after_voting": (
        "day",
        "После голосования",
        "Composite: opener + имя_изгнанного + closer.",
    ),
    "tie_first": ("day", "Ничья: первая попытка", None),
    "tie_host_kick": ("day", "Ничья: ведущий выгоняет", "Composite с именем изгнанного."),
    "tie_players_chose": ("day", "Ничья: игроки решили", "Composite с именем изгнанного."),
    "end_day_start_night_2": ("day", "Конец дня → начало ночи 2", None),
    # Finale
    "mafia_win_pre": ("finale", "Мафия побеждает: pre", None),
    "mafia_win_post": ("finale", "Мафия побеждает: post", None),
    "city_win_pre": ("finale", "Город побеждает: pre", None),
    "city_win_post": ("finale", "Город побеждает: post", None),
    "maniac_win_pre": ("finale", "Маньяк побеждает: pre", None),
    "maniac_win_post": ("finale", "Маньяк побеждает: post", None),
    # Text-only (no mp3 in audio_manifest) — see TEXT_ONLY_TRIGGERS below.
    "lover_intro": ("night_lover", "Любовница: вступление", None),
    "lover_outro": ("night_lover", "Любовница: завершение", None),
    "maniac_intro_1": ("night_maniac", "Маньяк: вступление 1", None),
    "maniac_intro_2": ("night_maniac", "Маньяк: вступление 2", None),
    "maniac_outro": ("night_maniac", "Маньяк: завершение", None),
    "morning_intro": ("day", "Утро: интро (1-я ночь)", None),
    "morning_intro_late": ("day", "Утро: интро (2+ ночи)", None),
    "multiple_killed": (
        "day",
        "Несколько погибших",
        "Несколько жертв ночи. Вариант с placeholder'ом {died_player_names}.",
    ),
    "multiple_killed_with_save": (
        "day",
        "Несколько погибших + спасённый",
        "Несколько целей мафии, доктор спас одного. Placeholders: {saved_player_name}, {died_player_names}.",
    ),
    "one_killed_with_save": (
        "day",
        "Один убитый + спасённый",
        "Доктор спас одного, но погиб другой. Placeholders: {saved_player_name}, {died_player_name}.",
    ),
    "day_blocked_player": (
        "day",
        "Заблокирован на голосование",
        "Игрок не допущен к голосованию (любовница). Placeholder: {blocked_player_name}.",
    ),
}


# ---------------------------------------------------------------------------
# Text-only triggers — фразы, для которых в audio_manifest нет mp3.
# Каждый вариант — это шаблон с {placeholder} в Python format-нотации;
# на runtime narrator_repo.build_steps подставит значения из ctx.
# Список синхронизирован с narration_script.py (commit pre-M7).
# ---------------------------------------------------------------------------
TEXT_ONLY_TRIGGERS: dict[str, list[str]] = {
    "lover_intro": [
        "Конечно же, ночью не дремлет любовь, Любви преисполниться тёмная ночь! Любовница, откройте глаза и выберете своего возлюбленного для ночных удовольствий",
    ],
    "lover_outro": [
        "Любовница выбрала возлюбленного, у кого-то будет прекрасная ночь! Закрывайте глаза, девушка",
    ],
    "maniac_intro_1": [
        "Убийства еще не закончены.. в городе полно сумасшедших людей",
    ],
    "maniac_intro_2": [
        "Маньяк знает все улочки этого темного города,… откройте глаза и выберите вашу сегодняшнюю жертву",
    ],
    "maniac_outro": [
        "Уф… маньяк сделал свой выбор, закрывайте глаза..",
    ],
    "morning_intro": [
        "Вот и прошла напряженная ночь, город просыпается, пора узнать результаты!",
        "И тааааак, наступает утро…. Город просыпается, улицы оживают… но к сожалению сегодняшней ночью были совершены жестокие преступления, о которых нельзя молчать этим днем",
    ],
    "morning_intro_late": [
        "Ночь подходит к своему концу… и наступает утро… какие же новости у нас сегодня?",
    ],
    "multiple_killed": [
        "Сегодня трагично погибли игроки {died_player_names}... доктор не успел спасти невинные души",
        "Этой ночью были убиты игроки {died_player_names}... скорая помощь приехала на другие вызовы",
        "К сожалению, сегодня убили игроков {died_player_names}, врач был очень занят другими пациентами",
    ],
    "multiple_killed_with_save": [
        "Сегодня должно было погибнуть 2 игрока {saved_player_name} и {died_player_names}…. Но Доктор вовремя приехал на вызов и спас игрока {saved_player_name}",
    ],
    "one_killed_with_save": [
        "Сегодня должно было умереть несколько человек, но доктор вовремя приехал на вызов и спас игрока {saved_player_name}, но к сожалению игрок {died_player_name} не смог спастись….",
    ],
    "day_blocked_player": [
        "На сегодняшнее голосование не допускается игрок {blocked_player_name}, у него была очень сладкая ночь!",
    ],
}


# ---------------------------------------------------------------------------
# Stats accumulator
# ---------------------------------------------------------------------------
class Stats:
    def __init__(self) -> None:
        self.audio_inserted = 0
        self.audio_skipped = 0
        self.audio_copied = 0
        self.trigger_inserted = 0
        self.trigger_skipped = 0
        self.variant_inserted = 0
        self.template_inserted = 0
        self.segment_inserted = 0
        self.name_inserted = 0
        self.name_skipped = 0

    def report(self) -> str:
        return (
            f"audio: inserted={self.audio_inserted} skipped={self.audio_skipped} copied={self.audio_copied}\n"
            f"triggers: inserted={self.trigger_inserted} skipped={self.trigger_skipped}\n"
            f"variants: inserted={self.variant_inserted}\n"
            f"composite templates: inserted={self.template_inserted}\n"
            f"composite segments: inserted={self.segment_inserted}\n"
            f"name assets: inserted={self.name_inserted} skipped={self.name_skipped}"
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_AUDIO_URL_PREFIX = "/audio/"


def _storage_path_from_url(audio_url: str) -> str:
    """``/audio/night/foo.mp3`` -> ``night/foo.mp3`` (relative to AUDIO_STORAGE_ROOT)."""
    if not audio_url.startswith(_AUDIO_URL_PREFIX):
        raise ValueError(f"Unexpected audio_url shape: {audio_url!r}")
    return audio_url[len(_AUDIO_URL_PREFIX):]


async def _get_or_create_audio_file(
    db: AsyncSession,
    *,
    file_name: str,
    storage_path: str,
    duration_ms: int,
    audio_src_root: Path,
    audio_dst_root: Path,
    stats: Stats,
    dry_run: bool,
) -> NarratorAudioFile:
    """Return existing audio row by filename, or insert + copy physical mp3."""
    existing = await db.scalar(
        select(NarratorAudioFile).where(NarratorAudioFile.filename == file_name)
    )
    if existing is not None:
        stats.audio_skipped += 1
        return existing

    src = audio_src_root / storage_path
    if not src.exists():
        raise FileNotFoundError(f"Source mp3 not found: {src}")
    size_bytes = src.stat().st_size

    dst = audio_dst_root / storage_path
    if not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            shutil.copy2(src, dst)
            stats.audio_copied += 1

    af = NarratorAudioFile(
        id=uuid.uuid4(),
        filename=file_name,
        storage_path=storage_path,
        duration_ms=duration_ms,
        size_bytes=size_bytes,
        uploaded_by_id=None,
    )
    if not dry_run:
        db.add(af)
        await db.flush()
    stats.audio_inserted += 1
    logger.info("audio.created filename=%s storage_path=%s", file_name, storage_path)
    return af


async def _get_or_create_trigger(
    db: AsyncSession,
    *,
    slug: str,
    kind: str,
    stats: Stats,
    dry_run: bool,
) -> tuple[NarratorTrigger, bool]:
    """Return ``(trigger, created)`` tuple. ``created=False`` means trigger already existed."""
    existing = await db.scalar(select(NarratorTrigger).where(NarratorTrigger.slug == slug))
    if existing is not None:
        stats.trigger_skipped += 1
        return existing, False

    meta = TRIGGER_META.get(slug)
    if meta is None:
        # Fallback for unknown slugs — use slug as label, place in 'misc' group.
        logger.warning("trigger.meta_missing slug=%s — fallback to misc/%s", slug, slug)
        group_key, label, description = "misc", slug.replace("_", " ").title(), None
    else:
        group_key, label, description = meta

    trigger = NarratorTrigger(
        id=uuid.uuid4(),
        slug=slug,
        group_key=group_key,
        label=label,
        description=description,
        kind=kind,
    )
    if not dry_run:
        db.add(trigger)
        await db.flush()
    stats.trigger_inserted += 1
    logger.info("trigger.created slug=%s kind=%s group=%s", slug, kind, group_key)
    return trigger, True


# ---------------------------------------------------------------------------
# Per-kind seeding
# ---------------------------------------------------------------------------


async def seed_variant_trigger(
    db: AsyncSession,
    *,
    slug: str,
    manifest_trigger: dict[str, Any],
    audio_src_root: Path,
    audio_dst_root: Path,
    stats: Stats,
    dry_run: bool,
) -> None:
    trigger, created = await _get_or_create_trigger(
        db, slug=slug, kind="variant", stats=stats, dry_run=dry_run
    )
    if not created:
        # Triggers are seeded once; we don't try to merge variants on re-runs.
        return

    for idx, v in enumerate(manifest_trigger.get("variants", [])):
        audio_url = v.get("audio_url")
        file_name = v.get("file_name")
        duration_ms = int(v.get("duration_ms", 0))
        text = v.get("text", "").strip()
        if not (audio_url and file_name):
            logger.warning("variant.skipped reason=missing_audio slug=%s idx=%d", slug, idx)
            continue

        storage_path = _storage_path_from_url(audio_url)
        audio_file = await _get_or_create_audio_file(
            db,
            file_name=file_name,
            storage_path=storage_path,
            duration_ms=duration_ms,
            audio_src_root=audio_src_root,
            audio_dst_root=audio_dst_root,
            stats=stats,
            dry_run=dry_run,
        )

        variant = NarratorVariant(
            id=uuid.uuid4(),
            trigger_id=trigger.id,
            audio_file_id=audio_file.id,
            text=text,
            duration_ms=duration_ms,
            sort_order=idx,
        )
        if not dry_run:
            db.add(variant)
            await db.flush()
        stats.variant_inserted += 1


async def seed_composite_trigger(
    db: AsyncSession,
    *,
    slug: str,
    pairs: list[dict[str, Any]],
    audio_src_root: Path,
    audio_dst_root: Path,
    stats: Stats,
    dry_run: bool,
) -> None:
    """Create a composite trigger with N templates, each = 3 segments (audio + placeholder + audio)."""
    trigger, created = await _get_or_create_trigger(
        db, slug=slug, kind="composite", stats=stats, dry_run=dry_run
    )
    if not created:
        return

    for idx, pair in enumerate(pairs):
        opener = pair.get("opener", {}) or {}
        closer = pair.get("closer", {}) or {}
        gender = pair.get("gender") or "any"
        pair_id = pair.get("id", idx + 1)
        label = f"{gender}_{pair_id}"

        opener_audio = await _get_or_create_audio_file(
            db,
            file_name=opener["file_name"],
            storage_path=_storage_path_from_url(opener["audio_url"]),
            duration_ms=int(opener.get("duration_ms", 0)),
            audio_src_root=audio_src_root,
            audio_dst_root=audio_dst_root,
            stats=stats,
            dry_run=dry_run,
        )
        closer_audio = await _get_or_create_audio_file(
            db,
            file_name=closer["file_name"],
            storage_path=_storage_path_from_url(closer["audio_url"]),
            duration_ms=int(closer.get("duration_ms", 0)),
            audio_src_root=audio_src_root,
            audio_dst_root=audio_dst_root,
            stats=stats,
            dry_run=dry_run,
        )

        template = NarratorCompositeTemplate(
            id=uuid.uuid4(),
            trigger_id=trigger.id,
            label=label,
            sort_order=idx,
        )
        if not dry_run:
            db.add(template)
            await db.flush()
        stats.template_inserted += 1

        segments = [
            NarratorCompositeSegment(
                id=uuid.uuid4(),
                template_id=template.id,
                position=0,
                kind="audio",
                audio_file_id=opener_audio.id,
                placeholder_key=None,
                text_fragment=opener.get("text", "").strip(),
            ),
            NarratorCompositeSegment(
                id=uuid.uuid4(),
                template_id=template.id,
                position=1,
                kind="placeholder",
                audio_file_id=None,
                placeholder_key="player_name",
                text_fragment="",
            ),
            NarratorCompositeSegment(
                id=uuid.uuid4(),
                template_id=template.id,
                position=2,
                kind="audio",
                audio_file_id=closer_audio.id,
                placeholder_key=None,
                text_fragment=closer.get("text", "").strip(),
            ),
        ]
        for seg in segments:
            if not dry_run:
                db.add(seg)
            stats.segment_inserted += 1
        if not dry_run:
            await db.flush()


async def seed_text_only_triggers(
    db: AsyncSession,
    *,
    stats: Stats,
    dry_run: bool,
) -> None:
    """Seed triggers that have no mp3 in audio_manifest (text-only fallback variants).

    Каждый вариант — variant без ``audio_file_id``. ``duration_ms`` оставляем None,
    runtime считает по ``estimate_duration_ms`` (см. narration_script.py).
    Идемпотентно: re-run пропускает существующие slug'и.
    """
    for slug, texts in TEXT_ONLY_TRIGGERS.items():
        trigger, created = await _get_or_create_trigger(
            db, slug=slug, kind="variant", stats=stats, dry_run=dry_run
        )
        if not created:
            continue

        for idx, text in enumerate(texts):
            variant = NarratorVariant(
                id=uuid.uuid4(),
                trigger_id=trigger.id,
                audio_file_id=None,
                text=text.strip(),
                duration_ms=None,
                sort_order=idx,
            )
            if not dry_run:
                db.add(variant)
                await db.flush()
            stats.variant_inserted += 1


async def seed_name_asset(
    db: AsyncSession,
    *,
    name_data: dict[str, Any],
    audio_src_root: Path,
    audio_dst_root: Path,
    stats: Stats,
    dry_run: bool,
) -> None:
    slug = name_data["slug"]
    display = name_data["display"]
    gender = name_data["gender"]
    file_name = name_data["file_name"]
    audio_url = name_data["intro_audio"]
    duration_ms = int(name_data.get("intro_duration_ms", 0))

    existing = await db.scalar(
        select(NarratorNameAsset).where(NarratorNameAsset.slug == slug)
    )
    if existing is not None:
        stats.name_skipped += 1
        return

    audio_file = await _get_or_create_audio_file(
        db,
        file_name=file_name,
        storage_path=_storage_path_from_url(audio_url),
        duration_ms=duration_ms,
        audio_src_root=audio_src_root,
        audio_dst_root=audio_dst_root,
        stats=stats,
        dry_run=dry_run,
    )

    asset = NarratorNameAsset(
        id=uuid.uuid4(),
        display_name=display,
        slug=slug,
        gender=gender,
        audio_file_id=audio_file.id,
    )
    if not dry_run:
        db.add(asset)
        await db.flush()
    stats.name_inserted += 1
    logger.info("name.created slug=%s display=%s gender=%s", slug, display, gender)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def run_migration(
    *,
    manifest_path: Path,
    audio_src_root: Path,
    audio_dst_root: Path,
    dry_run: bool,
) -> Stats:
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    triggers = manifest.get("triggers", {})
    names = manifest.get("names", [])
    stats = Stats()

    if not dry_run:
        audio_dst_root.mkdir(parents=True, exist_ok=True)

    async with async_session_factory() as db:
        # 1. Variant triggers
        for slug, trig in triggers.items():
            if trig.get("kind") != "variant":
                continue
            await seed_variant_trigger(
                db,
                slug=slug,
                manifest_trigger=trig,
                audio_src_root=audio_src_root,
                audio_dst_root=audio_dst_root,
                stats=stats,
                dry_run=dry_run,
            )

        # 2. Composite (name_pair) triggers
        for slug, trig in triggers.items():
            if trig.get("kind") != "name_pair":
                continue
            all_pairs = trig.get("pairs", [])
            # one_killed has female/male pairs — split into two slugs.
            if slug == "one_killed":
                female = [p for p in all_pairs if p.get("gender") == "f"]
                male = [p for p in all_pairs if p.get("gender") == "m"]
                if female:
                    await seed_composite_trigger(
                        db,
                        slug="one_killed_female",
                        pairs=female,
                        audio_src_root=audio_src_root,
                        audio_dst_root=audio_dst_root,
                        stats=stats,
                        dry_run=dry_run,
                    )
                if male:
                    await seed_composite_trigger(
                        db,
                        slug="one_killed_male",
                        pairs=male,
                        audio_src_root=audio_src_root,
                        audio_dst_root=audio_dst_root,
                        stats=stats,
                        dry_run=dry_run,
                    )
            else:
                await seed_composite_trigger(
                    db,
                    slug=slug,
                    pairs=all_pairs,
                    audio_src_root=audio_src_root,
                    audio_dst_root=audio_dst_root,
                    stats=stats,
                    dry_run=dry_run,
                )

        # 3. Text-only triggers (без mp3) — синхронизированы с narration_script.py
        await seed_text_only_triggers(db, stats=stats, dry_run=dry_run)

        # 4. Name assets
        for n in names:
            await seed_name_asset(
                db,
                name_data=n,
                audio_src_root=audio_src_root,
                audio_dst_root=audio_dst_root,
                stats=stats,
                dry_run=dry_run,
            )

        if dry_run:
            logger.warning("DRY-RUN — rolling back")
            await db.rollback()
        else:
            await db.commit()
            logger.info("committed")

    return stats


def _default_manifest_path() -> Path:
    # backend/scripts/migrate_narrator_to_db.py  ->  ../../audio_manifest.json
    return _BACKEND_ROOT.parent / "audio_manifest.json"


def _default_audio_src() -> Path:
    return _BACKEND_ROOT.parent / "frontend" / "public" / "audio"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, default=_default_manifest_path(), help="Path to audio_manifest.json")
    parser.add_argument("--audio-src", type=Path, default=_default_audio_src(), help="Source mp3 directory")
    parser.add_argument("--dry-run", action="store_true", help="Don't modify DB / filesystem; print what would happen")
    args = parser.parse_args(argv)

    audio_dst = settings.audio_storage_path
    logger.info("manifest=%s audio_src=%s audio_dst=%s dry_run=%s", args.manifest, args.audio_src, audio_dst, args.dry_run)
    if not args.manifest.exists():
        logger.error("manifest not found: %s", args.manifest)
        return 1
    if not args.audio_src.exists():
        logger.error("audio src not found: %s", args.audio_src)
        return 1

    stats = asyncio.run(
        run_migration(
            manifest_path=args.manifest,
            audio_src_root=args.audio_src,
            audio_dst_root=audio_dst,
            dry_run=args.dry_run,
        )
    )
    logger.info("DONE\n%s", stats.report())
    return 0


if __name__ == "__main__":
    sys.exit(main())
