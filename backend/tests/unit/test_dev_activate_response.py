"""Регресс-тесты для POST /dev/test-lobbies/activate.

Контекст бага: до фикса эндпоинт собирал MeResponse без is_admin/avatar_url.
Pydantic ResponseValidationError проваливался через BaseHTTPMiddleware +
CORSMiddleware некорректно — браузер видел оборванное соединение, axios
репортил ERR_NETWORK, фронт писал «Нет связи с сервером».

Тесты:
1. Helper заполняет все обязательные поля MeResponse.
2. Generic-проверка: если в MeResponse появится новое обязательное поле,
   а helper его не заполнит — тест упадёт с подсказкой обновить helper.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from api.routers.dev import _build_me_response_for_dev_player
from schemas.auth import MeResponse


def _make_user(**overrides):
    """Строит SimpleNamespace, имитирующий models.User для helper'а."""
    base = dict(
        id=uuid.uuid4(),
        email="dev@example.com",
        display_name="Dev Player 1",
        avatar_url=None,
        is_admin=False,
        created_at=datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_build_me_response_for_dev_player_returns_valid_me_response():
    user = _make_user()

    me = _build_me_response_for_dev_player(user)

    assert isinstance(me, MeResponse)
    assert me.user_id == str(user.id)
    assert me.email == "dev@example.com"
    assert me.nickname == "Dev Player 1"
    assert me.has_pro is False
    assert me.is_admin is False
    assert me.avatar_url is None
    assert me.created_at == "2026-01-15T12:00:00+00:00"


def test_build_me_response_for_dev_player_passes_admin_and_avatar_through():
    user = _make_user(is_admin=True, avatar_url="data:image/png;base64,abc")

    me = _build_me_response_for_dev_player(user)

    assert me.is_admin is True
    assert me.avatar_url == "data:image/png;base64,abc"


def test_build_me_response_for_dev_player_handles_missing_created_at():
    user = _make_user(created_at=None)

    me = _build_me_response_for_dev_player(user)

    assert me.created_at == ""


def test_build_me_response_includes_all_known_me_response_fields():
    """Страховка от исходного бага: если в MeResponse добавят новое поле,
    а в _build_me_response_for_dev_player его не заполнят — этот тест упадёт
    с явной подсказкой обновить helper.

    Список захардкожен (а не интроспектится через `MeResponse.model_fields`),
    потому что `tests/conftest.py` подменяет `pydantic` на stub без
    `model_fields`. Поэтому при добавлении нового поля в @schemas/auth.py
    нужно ОБНОВИТЬ оба места: и MeResponse, и `EXPECTED_FIELDS` ниже,
    и helper `_build_me_response_for_dev_player`."""
    user = _make_user()

    me = _build_me_response_for_dev_player(user)

    EXPECTED_FIELDS = {
        "user_id",
        "email",
        "nickname",
        "has_pro",
        "is_admin",
        "created_at",
        "avatar_url",
    }

    missing = [f for f in EXPECTED_FIELDS if not hasattr(me, f)]
    assert not missing, (
        f"_build_me_response_for_dev_player не заполнил поля {missing} — "
        "обнови helper в backend/api/routers/dev.py. "
        "Без этих полей FastAPI не сможет собрать ответ /dev/test-lobbies/activate "
        "и фронт получит «Нет связи с сервером»."
    )
