from __future__ import annotations

import asyncio
import os
import sys
import types

import pytest
from sqlalchemy.orm import DeclarativeBase


# --- Module stubs (run before any service import) ---

fastapi_stub = types.ModuleType("fastapi")
fastapi_stub.Request = object
fastapi_stub.WebSocket = object
fastapi_stub.APIRouter = type("APIRouter", (), {"get": lambda *a, **kw: lambda f: f, "post": lambda *a, **kw: lambda f: f, "put": lambda *a, **kw: lambda f: f, "patch": lambda *a, **kw: lambda f: f, "delete": lambda *a, **kw: lambda f: f})
fastapi_stub.Depends = lambda x=None: None
fastapi_stub.Query = lambda *a, **kw: None
# File/Form/UploadFile/Response — нужны для multipart-роутеров (admin_narrator
# upload_audio_file и т.п.). Без них импорт роутера в unit-тесте падает.
fastapi_stub.File = lambda *a, **kw: None
fastapi_stub.Form = lambda *a, **kw: None
fastapi_stub.UploadFile = object
fastapi_stub.Response = object
fastapi_stub.HTTPException = type("HTTPException", (Exception,), {"__init__": lambda self, *a, **kw: None})
# status — модуль с HTTP константами. Используется как status.HTTP_201_CREATED.
fastapi_status_stub = types.SimpleNamespace(
    HTTP_200_OK=200,
    HTTP_201_CREATED=201,
    HTTP_204_NO_CONTENT=204,
    HTTP_400_BAD_REQUEST=400,
    HTTP_401_UNAUTHORIZED=401,
    HTTP_403_FORBIDDEN=403,
    HTTP_404_NOT_FOUND=404,
    HTTP_409_CONFLICT=409,
    HTTP_422_UNPROCESSABLE_ENTITY=422,
    HTTP_500_INTERNAL_SERVER_ERROR=500,
)
fastapi_stub.status = fastapi_status_stub

fastapi_responses_stub = types.ModuleType("fastapi.responses")
fastapi_responses_stub.JSONResponse = object

fastapi_security_stub = types.ModuleType("fastapi.security")
fastapi_security_stub.HTTPBearer = type("HTTPBearer", (), {"__init__": lambda self: None})
fastapi_security_stub.HTTPAuthorizationCredentials = object

pydantic_stub = types.ModuleType("pydantic")
pydantic_stub.Field = lambda default=None, **kwargs: default


class _BaseModel:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


pydantic_stub.BaseModel = _BaseModel
pydantic_stub.EmailStr = str
pydantic_stub.field_validator = lambda *a, **kw: lambda f: f

pydantic_settings_stub = types.ModuleType("pydantic_settings")


class _BaseSettings:
    def __init__(self, **kwargs):
        for name, value in self.__class__.__dict__.items():
            if name.startswith("_") or isinstance(value, property) or callable(value):
                continue
            setattr(self, name, kwargs.get(name, value))


pydantic_settings_stub.BaseSettings = _BaseSettings
pydantic_settings_stub.SettingsConfigDict = dict

core_database_stub = types.ModuleType("core.database")


class _Base(DeclarativeBase):
    pass


core_database_stub.Base = _Base
core_database_stub.async_session_factory = object()
core_database_stub.async_session_maker = object()
core_database_stub.get_async_session = object()

sys.modules.setdefault("fastapi", fastapi_stub)
sys.modules.setdefault("fastapi.responses", fastapi_responses_stub)
sys.modules.setdefault("fastapi.security", fastapi_security_stub)
sys.modules.setdefault("pydantic", pydantic_stub)
sys.modules.setdefault("pydantic_settings", pydantic_settings_stub)
sys.modules.setdefault("core.database", core_database_stub)


# --- Fixtures ---


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session", autouse=True)
def _set_test_env():
    os.environ.setdefault("SECRET_KEY", "test-secret-key-32-characters-minimum!!")
    # Отключает rate-limiter в core/rate_limit.py — иначе integration-тесты
    # могут наткнуться на 429 при многократных авторизациях в одной сессии.
    os.environ.setdefault("APP_ENV", "test")
