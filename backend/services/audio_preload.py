"""Pregame audio preload readiness.

Stores readiness in ``Session.settings`` so the game can wait for every
connected player to cache the current audio manifest before role reveal starts.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.exceptions import GameError
from core.utils import utc_now
from models.player import Player
from models.session import Session
from services.audio_manifest import AudioManifest, get_manifest
from services.story_audio import collect_story_audio_urls, story_audio_version

AUDIO_PRELOAD_SETTINGS_KEY = "audio_preload"


def _manifest_urls(manifest: AudioManifest) -> list[str]:
    urls: set[str] = set()
    for name in manifest.names:
        if name.intro_audio:
            urls.add(name.intro_audio)
    for trigger in manifest.triggers.values():
        for variant in trigger.variants:
            if variant.audio_url:
                urls.add(variant.audio_url)
        for pair in trigger.pairs:
            if pair.opener.audio_url:
                urls.add(pair.opener.audio_url)
            if pair.closer.audio_url:
                urls.add(pair.closer.audio_url)
    return sorted(urls)


def _audio_urls_count(manifest: AudioManifest) -> int:
    return len(_manifest_urls(manifest))


async def session_audio_plan(db: AsyncSession, session: Session) -> dict:
    """Набор озвучки, который должен предзагрузить клиент для этой сессии.

    - story-движок, сюжет уже выбран (``story_id`` проставлен после
      голосования): только аудио ЭТОГО сюжета. Раньше тянулось объединение всех
      голосуемых сюжетов ещё до выбора — нелогично и лишний трафик. Теперь фронт
      качает озвучку конкретного сюжета на фазе ``name_pick`` (после
      ``story_vote``). ``via_api=True`` — файлы в backend storage.
    - story-движок, сюжет ещё НЕ выбран (комната ожидания / голосование): пустой
      план — заранее качать нечего, ``required=False``. Старт игры для
      story-сессий и так не гейтится готовностью озвучки (см. start_story_vote),
      а воспроизведение умеет тянуть файл из storage на лету.
    - иначе (legacy / нет сюжетов): глобальный манифест ведущего (как раньше),
      ``via_api`` False — seed-файлы отдаёт origin фронта.
    """
    settings = dict(session.settings or {})
    if settings.get("use_story_engine"):
        if session.story_id is not None:
            urls = await collect_story_audio_urls(
                db, [session.story_id], session_id=session.id
            )
            return {
                "source": "story",
                "version": story_audio_version(urls),
                "audio_urls": urls,
                "via_api": True,
            }
        # Сюжет ещё не выбран — ничего не предзагружаем заранее.
        return {
            "source": "story_pending",
            "version": story_audio_version([]),
            "audio_urls": [],
            "via_api": True,
        }

    manifest = get_manifest()
    return {
        "source": "manifest",
        "version": manifest.version,
        "audio_urls": _manifest_urls(manifest),
        "via_api": False,
    }


def _ready_map(settings: dict[str, Any], manifest_version: str) -> dict[str, str]:
    raw = settings.get(AUDIO_PRELOAD_SETTINGS_KEY)
    if not isinstance(raw, dict):
        return {}
    if raw.get("manifest_version") != manifest_version:
        return {}
    ready = raw.get("ready")
    if not isinstance(ready, dict):
        return {}
    return {str(player_id): str(marked_at) for player_id, marked_at in ready.items()}


def _status_for(
    settings: dict[str, Any] | None,
    players: list[Player],
    *,
    version: str,
    audio_count: int,
) -> dict:
    player_ids = {str(player.id) for player in players}
    ready = _ready_map(dict(settings or {}), version)
    ready_player_ids = sorted(player_id for player_id in ready if player_id in player_ids)
    return {
        "manifest_version": version,
        "required": audio_count > 0,
        "audio_count": audio_count,
        "ready_count": len(ready_player_ids),
        "players_total": len(player_ids),
        "ready_player_ids": ready_player_ids,
    }


def build_audio_preload_status(
    settings: dict[str, Any] | None,
    players: list[Player],
    *,
    manifest: AudioManifest | None = None,
) -> dict:
    manifest = manifest or get_manifest()
    return _status_for(
        settings,
        players,
        version=manifest.version,
        audio_count=_audio_urls_count(manifest),
    )


async def get_audio_preload_status(db: AsyncSession, session: Session) -> dict:
    players = (await db.scalars(select(Player).where(Player.session_id == session.id))).all()
    plan = await session_audio_plan(db, session)
    return _status_for(
        session.settings,
        list(players),
        version=plan["version"],
        audio_count=len(plan["audio_urls"]),
    )


async def mark_audio_preload_ready(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    player_id: uuid.UUID,
    manifest_version: str,
) -> tuple[Session, dict]:
    session = await db.scalar(select(Session).where(Session.id == session_id).with_for_update())
    if session is None:
        raise GameError(404, "session_not_found", "Сессия не найдена")
    if session.status != "waiting":
        raise GameError(409, "wrong_phase", "Озвучку можно подготовить только до старта игры")

    plan = await session_audio_plan(db, session)
    if manifest_version != plan["version"]:
        raise GameError(409, "audio_manifest_mismatch", "Версия озвучки устарела, обновите страницу")

    settings = dict(session.settings or {})
    ready = _ready_map(settings, plan["version"])
    ready[str(player_id)] = utc_now().isoformat()
    settings[AUDIO_PRELOAD_SETTINGS_KEY] = {
        "manifest_version": plan["version"],
        "ready": ready,
    }
    session.settings = settings
    await db.commit()

    status = await get_audio_preload_status(db, session)
    return session, status


async def ensure_audio_preload_ready(db: AsyncSession, session: Session) -> None:
    status = await get_audio_preload_status(db, session)
    if not status["required"]:
        return
    if status["players_total"] > 0 and status["ready_count"] >= status["players_total"]:
        return
    raise GameError(
        409,
        "audio_not_ready",
        f"Озвучка ещё загружается: {status['ready_count']}/{status['players_total']}",
    )


def clear_audio_preload(settings: dict[str, Any] | None) -> dict[str, Any]:
    cleaned = dict(settings or {})
    cleaned.pop(AUDIO_PRELOAD_SETTINGS_KEY, None)
    return cleaned
