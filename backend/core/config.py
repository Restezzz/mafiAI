"""Конфигурация приложения. Значения загружаются из `.env` файла."""

from __future__ import annotations

import json
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _parse_json_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(x) for x in value]
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return [str(x) for x in parsed]
            except Exception:
                pass
        return [v.strip() for v in s.split(",") if v.strip()]
    return [str(value)]


class Settings(BaseSettings):
    """Настройки приложения через переменные окружения."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    APP_ENV: str = Field(default="development")
    LOG_LEVEL: str = Field(default="DEBUG")
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/gamemaster"
    )
    SECRET_KEY: str = Field(default="change-me-to-a-random-string-at-least-32-chars")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # CORS_ORIGINS приходит как JSON-строка или как CSV.
    # Храним в виде строки, чтобы pydantic-settings не пытался парсить JSON
    # (list[str] заставляет его всегда звать json.loads). Превращаем в список
    # через свойство `cors_origins`.
    CORS_ORIGINS: str = Field(default="http://localhost:5173")

    # Режим отладки (включает логирование SQL-запросов)
    DEBUG: bool = False
    FRONTEND_LOG_INGEST_ENABLED: bool = True
    FRONTEND_LOG_REMOTE_MIN_LEVEL: str = Field(default="info")
    # Dev-only: открывает /api/observability/* для logs-frontend dashboard.
    # В production должен быть выключен — эндпоинты не требуют auth.
    OBSERVABILITY_ENABLED: bool = False

    @property
    def cors_origins(self) -> list[str]:
        return _parse_json_list(self.CORS_ORIGINS)


# Дефолтный SECRET_KEY из .env.example — байтово сравниваем, чтобы
# не допустить запуск прода с публично известным ключом подписи JWT.
_DEFAULT_DEV_SECRET_KEY = "change-me-to-a-random-string-at-least-32-chars"


def _validate_production(s: "Settings") -> None:
    """Жёсткие проверки production-конфига.

    Падаем на старте если:
    - APP_ENV=production, но SECRET_KEY = дефолтный (JWT подделываются).
    - APP_ENV=production, но OBSERVABILITY_ENABLED=true (открытые
      эндпоинты со списком сессий/юзеров без auth).
    - APP_ENV=production, но SECRET_KEY короче 32 символов.
    """
    if s.APP_ENV != "production":
        return
    if s.SECRET_KEY == _DEFAULT_DEV_SECRET_KEY:
        raise RuntimeError(
            "SECRET_KEY имеет дефолтное dev-значение. "
            "Сгенерируй: openssl rand -hex 32"
        )
    if len(s.SECRET_KEY) < 32:
        raise RuntimeError("SECRET_KEY короче 32 символов — недостаточно для HS256")
    if s.OBSERVABILITY_ENABLED:
        raise RuntimeError(
            "OBSERVABILITY_ENABLED=true в production. Эти эндпоинты без auth, выключи."
        )


settings = Settings()
_validate_production(settings)
