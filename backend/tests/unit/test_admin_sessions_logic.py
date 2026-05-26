"""Unit-тесты для чистой бизнес-логики admin_sessions роутера.

Тестируется ``_is_abandoned`` — функция, определяющая считать ли сессию
зависшей. Без БД, без FastAPI клиента: всё in-memory.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from api.routers.admin_sessions import (
    _is_abandoned,
    ACTIVE_ABANDONED_HOURS,
    WAITING_ABANDONED_HOURS,
)


# Фиксированное "сейчас" для воспроизводимости — все тесты используют его.
NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)


class TestWaitingStatus:
    def test_recent_waiting_not_abandoned(self) -> None:
        """waiting сессия созданная час назад — не abandoned."""
        created = NOW - timedelta(hours=1)
        assert not _is_abandoned("waiting", created, None, NOW)

    def test_waiting_at_threshold_not_abandoned(self) -> None:
        """waiting сессия ровно на пороге — не abandoned (строгое <)."""
        created = NOW - timedelta(hours=WAITING_ABANDONED_HOURS)
        assert not _is_abandoned("waiting", created, None, NOW)

    def test_waiting_past_threshold_is_abandoned(self) -> None:
        """waiting сессия чуть старше порога — abandoned."""
        created = NOW - timedelta(hours=WAITING_ABANDONED_HOURS, seconds=1)
        assert _is_abandoned("waiting", created, None, NOW)

    def test_waiting_ignores_last_phase_at(self) -> None:
        """Для waiting last_phase_at не учитывается (фаз нет)."""
        created = NOW - timedelta(hours=WAITING_ABANDONED_HOURS + 1)
        recent_phase = NOW - timedelta(minutes=1)
        assert _is_abandoned("waiting", created, recent_phase, NOW)


class TestActiveStatus:
    def test_active_with_recent_phase_not_abandoned(self) -> None:
        created = NOW - timedelta(hours=24)
        last_phase = NOW - timedelta(minutes=10)
        assert not _is_abandoned("active", created, last_phase, NOW)

    def test_active_with_old_phase_is_abandoned(self) -> None:
        created = NOW - timedelta(hours=24)
        last_phase = NOW - timedelta(hours=ACTIVE_ABANDONED_HOURS, seconds=1)
        assert _is_abandoned("active", created, last_phase, NOW)

    def test_active_with_no_phase_uses_created_at(self) -> None:
        """Если фаз нет, fallback на created_at."""
        # created_at свежий — не abandoned.
        created = NOW - timedelta(minutes=30)
        assert not _is_abandoned("active", created, None, NOW)
        # created_at старый — abandoned.
        created = NOW - timedelta(hours=ACTIVE_ABANDONED_HOURS, seconds=1)
        assert _is_abandoned("active", created, None, NOW)


class TestFinishedAndUnknownStatus:
    def test_finished_never_abandoned(self) -> None:
        """finished — корректно завершённая, какой бы старой ни была."""
        created = NOW - timedelta(days=365)
        assert not _is_abandoned("finished", created, None, NOW)

    def test_unknown_status_never_abandoned(self) -> None:
        """Защита от опечаток / новых статусов: не считаем abandoned пока
        правило не явно прописано."""
        created = NOW - timedelta(days=365)
        assert not _is_abandoned("zombie", created, None, NOW)


@pytest.mark.parametrize("hours", [WAITING_ABANDONED_HOURS, ACTIVE_ABANDONED_HOURS])
def test_threshold_constants_are_positive(hours: int) -> None:
    """Sanity: пороги положительные. Если кто-то случайно поставит 0 —
    каждая сессия мгновенно abandoned, тест упадёт."""
    assert hours > 0
