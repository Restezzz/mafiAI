from __future__ import annotations

from core.logging_middleware import _sanitize_request_id


def test_sanitize_valid_uuid():
    val = "550e8400-e29b-41d4-a716-446655440000"
    assert _sanitize_request_id(val) == val


def test_sanitize_valid_alnum():
    val = "abc123_DEF-456"
    assert _sanitize_request_id(val) == val


def test_sanitize_rejects_newline():
    """#21: log injection через newline должен отбрасываться."""
    assert _sanitize_request_id("abc\nINJECTED_LOG") is None


def test_sanitize_rejects_too_short():
    assert _sanitize_request_id("abc") is None


def test_sanitize_rejects_too_long():
    assert _sanitize_request_id("a" * 129) is None


def test_sanitize_rejects_special_chars():
    assert _sanitize_request_id("abc;DROP TABLE users--") is None
    assert _sanitize_request_id("abc<script>") is None
    assert _sanitize_request_id("abc def") is None


def test_sanitize_none_or_empty():
    assert _sanitize_request_id(None) is None
    assert _sanitize_request_id("") is None
