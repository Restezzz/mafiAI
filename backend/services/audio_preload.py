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

AUDIO_PRELOAD_SETTINGS_KEY = "audio_preload"


def _audio_urls_count(manifest: AudioManifest) -> int:
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
    return len(urls)


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


def build_audio_preload_status(
    settings: dict[str, Any] | None,
    players: list[Player],
    *,
    manifest: AudioManifest | None = None,
) -> dict:
    manifest = manifest or get_manifest()
    audio_count = _audio_urls_count(manifest)
    player_ids = {str(player.id) for player in players}
    ready = _ready_map(dict(settings or {}), manifest.version)
    ready_player_ids = sorted(player_id for player_id in ready if player_id in player_ids)
    return {
        "manifest_version": manifest.version,
        "required": audio_count > 0,
        "audio_count": audio_count,
        "ready_count": len(ready_player_ids),
        "players_total": len(player_ids),
        "ready_player_ids": ready_player_ids,
    }


async def get_audio_preload_status(db: AsyncSession, session: Session) -> dict:
    players = (await db.scalars(select(Player).where(Player.session_id == session.id))).all()
    return build_audio_preload_status(session.settings, list(players))


async def mark_audio_preload_ready(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    player_id: uuid.UUID,
    manifest_version: str,
) -> tuple[Session, dict]:
    manifest = get_manifest()
    if manifest_version != manifest.version:
        raise GameError(409, "audio_manifest_mismatch", "Версия озвучки устарела, обновите страницу")

    session = await db.scalar(select(Session).where(Session.id == session_id).with_for_update())
    if session is None:
        raise GameError(404, "session_not_found", "Сессия не найдена")
    if session.status != "waiting":
        raise GameError(409, "wrong_phase", "Озвучку можно подготовить только до старта игры")

    settings = dict(session.settings or {})
    ready = _ready_map(settings, manifest.version)
    ready[str(player_id)] = utc_now().isoformat()
    settings[AUDIO_PRELOAD_SETTINGS_KEY] = {
        "manifest_version": manifest.version,
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
