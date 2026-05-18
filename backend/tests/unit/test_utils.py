from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from core.utils import remaining_seconds, safe_uuid, session_is_paused, utc_now


def test_utc_now_returns_aware_datetime():
    now = utc_now()
    assert now.tzinfo is not None
    assert now.tzinfo == timezone.utc


def test_utc_now_is_close_to_real_now():
    now = utc_now()
    diff = abs((datetime.now(timezone.utc) - now).total_seconds())
    assert diff < 1


def test_remaining_seconds_normal():
    started = datetime.now(timezone.utc) - timedelta(seconds=10)
    result = remaining_seconds(30, started)
    assert 19 <= result <= 21


def test_remaining_seconds_clamped_to_zero_when_expired():
    # remaining_seconds зажимает результат через max(0, ...), чтобы фронт не
    # видел отрицательные таймеры (см. core/utils.py). При expired-таймере
    # ожидаем ровно 0, а не отрицательное значение.
    started = datetime.now(timezone.utc) - timedelta(seconds=100)
    result = remaining_seconds(30, started)
    assert result == 0


def test_remaining_seconds_none_when_timer_none():
    assert remaining_seconds(None, datetime.now(timezone.utc)) is None


def test_remaining_seconds_none_when_started_none():
    assert remaining_seconds(30, None) is None


def test_safe_uuid_valid_string():
    uid = uuid.uuid4()
    assert safe_uuid(str(uid)) == uid


def test_safe_uuid_valid_uuid():
    uid = uuid.uuid4()
    assert safe_uuid(uid) == uid


def test_safe_uuid_none():
    assert safe_uuid(None) is None


def test_safe_uuid_invalid():
    assert safe_uuid("not-a-uuid") is None


def test_session_is_paused_true():
    assert session_is_paused({"game_pause": {"paused": True}}) is True


def test_session_is_paused_false_not_paused():
    assert session_is_paused({"game_pause": {"paused": False}}) is False


def test_session_is_paused_false_no_key():
    assert session_is_paused({}) is False


def test_session_is_paused_false_none():
    assert session_is_paused(None) is False
