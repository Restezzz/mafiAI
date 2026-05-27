"""Regression: POST /dev/test-lobbies/activate должен возвращать валидный
MeResponse с обязательным полем `is_admin`.

Раньше `dev.activate_test_lobby_player` собирал `MeResponse` без `is_admin`
и без `avatar_url`. Pydantic валидация падала на сериализации response, и
exception проваливался через CORSMiddleware в виде Exception Group → клиент
видел `ERR_NETWORK` ("Нет связи с сервером") при попытке открыть вкладку
тестового игрока из dev-test-lobby. См. dev.py::_build_me_response_for_dev_player.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from api.routers.dev import _build_me_response_for_dev_player
from schemas.auth import MeResponse


def _fake_user(*, is_admin: bool = False, avatar_url: str | None = None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        email="dev@example.com",
        display_name="DevPlayer",
        is_admin=is_admin,
        avatar_url=avatar_url,
        created_at=datetime.now(timezone.utc),
    )


def test_build_me_response_includes_required_fields():
    user = _fake_user(is_admin=False, avatar_url=None)

    me = _build_me_response_for_dev_player(user)

    # Точно тот же набор полей, что и в /auth/me — иначе фронт ломается
    # на валидации UserProfile, а bootstrap dev-вкладки получает ошибку
    # сериализации (с CORSMiddleware → ERR_NETWORK на стороне axios).
    assert isinstance(me, MeResponse)
    assert me.user_id == str(user.id)
    assert me.email == user.email
    assert me.nickname == user.display_name
    assert me.is_admin is False
    assert me.has_pro is False
    assert me.avatar_url is None
    assert me.created_at  # ISO-timestamp


def test_build_me_response_propagates_admin_flag_and_avatar():
    user = _fake_user(is_admin=True, avatar_url="https://cdn.test/a.png")

    me = _build_me_response_for_dev_player(user)

    assert me.is_admin is True
    assert me.avatar_url == "https://cdn.test/a.png"


def test_build_me_response_covers_all_required_meresponse_fields():
    """Если в MeResponse добавят новое required-поле, helper упадёт здесь."""
    me = _build_me_response_for_dev_player(_fake_user())

    required_fields = {
        name for name, field in MeResponse.model_fields.items()
        if field.is_required()
    }
    dumped = me.model_dump()
    missing = required_fields - dumped.keys()
    assert not missing, (
        f"_build_me_response_for_dev_player пропустил обязательные поля "
        f"MeResponse: {missing}. Добавьте их в helper в dev.py."
    )
