"""Общие утилиты без зависимостей от БД."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def remaining_seconds(timer_seconds: int | None, started_at: datetime | None) -> int | None:
    if timer_seconds is None or started_at is None:
        return None
    elapsed = (utc_now() - started_at).total_seconds()
    # timer_seconds - int(elapsed) — округляем только elapsed, чтобы совпадало
    # с фронтовым `timer_seconds - Math.floor(elapsed)`. Иначе при паузе на 30.7с
    # бэк сохранял бы int(120 - 30.7) = 89, а на экране у юзера было бы 90.
    return max(0, timer_seconds - int(elapsed))


def safe_uuid(raw) -> uuid.UUID | None:
    if raw is None:
        return None
    try:
        return uuid.UUID(str(raw))
    except Exception:
        return None


def session_is_paused(settings: dict | None) -> bool:
    gp = (settings or {}).get("game_pause")
    return isinstance(gp, dict) and bool(gp.get("paused"))
