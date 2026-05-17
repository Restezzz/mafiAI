from __future__ import annotations

import uuid
from types import SimpleNamespace

from services.audio_preload import AUDIO_PRELOAD_SETTINGS_KEY, build_audio_preload_status


def _manifest(version: str = "v1"):
    return SimpleNamespace(
        version=version,
        names=[SimpleNamespace(intro_audio="/audio/name.mp3")],
        triggers={
            "variant": SimpleNamespace(
                variants=[SimpleNamespace(audio_url="/audio/variant.mp3")],
                pairs=[],
            ),
            "pair": SimpleNamespace(
                variants=[],
                pairs=[
                    SimpleNamespace(
                        opener=SimpleNamespace(audio_url="/audio/open.mp3"),
                        closer=SimpleNamespace(audio_url="/audio/close.mp3"),
                    )
                ],
            ),
        },
    )


def test_build_audio_preload_status_counts_ready_players_for_current_manifest() -> None:
    ready_player = SimpleNamespace(id=uuid.uuid4())
    pending_player = SimpleNamespace(id=uuid.uuid4())
    settings = {
        AUDIO_PRELOAD_SETTINGS_KEY: {
            "manifest_version": "v1",
            "ready": {
                str(ready_player.id): "now",
                str(uuid.uuid4()): "stale-player",
            },
        }
    }

    status = build_audio_preload_status(
        settings,
        [ready_player, pending_player],
        manifest=_manifest(),
    )

    assert status["required"] is True
    assert status["audio_count"] == 4
    assert status["players_total"] == 2
    assert status["ready_count"] == 1
    assert status["ready_player_ids"] == [str(ready_player.id)]


def test_build_audio_preload_status_ignores_stale_manifest_readiness() -> None:
    player = SimpleNamespace(id=uuid.uuid4())
    settings = {
        AUDIO_PRELOAD_SETTINGS_KEY: {
            "manifest_version": "old",
            "ready": {str(player.id): "now"},
        }
    }

    status = build_audio_preload_status(settings, [player], manifest=_manifest())

    assert status["ready_count"] == 0
    assert status["ready_player_ids"] == []
