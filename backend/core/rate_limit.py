"""Rate limiting через slowapi.

In-memory backend подходит для single-worker setup. При переходе на
multi-worker — поднять Redis и сменить storage_uri в `Limiter(...)`.
"""

from __future__ import annotations

import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from core.config import settings
from core.logging import log_event


logger = logging.getLogger(__name__)


def _client_key(request: Request) -> str:
    """Ключ rate-limit'а.

    В тестах и dev обычно работаем через локалхост — `get_remote_address`
    вернёт 127.0.0.1 и лимит станет общим на всех. В таких случаях клиент,
    залогиненный с разных user-agents/устройств, всё равно поделит один
    лимит — это намеренно: rate limit на /login/register по своей сути
    защищает от IP-перебора, а не от users.

    За reverse-proxy (nginx, traefik) нужно настроить proxy_set_header
    X-Forwarded-For + использовать `--proxy-headers` в uvicorn — иначе
    все запросы будут от IP прокси.
    """
    return get_remote_address(request)


# Лимиты лояльные: задача — отсечь перебор, не мешать живым пользователям.
# При желании пересмотреть, поднять в settings.
limiter = Limiter(
    key_func=_client_key,
    default_limits=[],  # глобального лимита нет — только per-route
    headers_enabled=True,  # X-RateLimit-* для отладки
    enabled=settings.APP_ENV != "test",  # отключаем в тестах
)


async def rate_limit_exceeded_handler(request: Request, exc: Exception) -> JSONResponse:
    """Возвращает 429 в формате нашей GameError-схемы."""
    assert isinstance(exc, RateLimitExceeded)
    log_event(
        logger,
        logging.WARNING,
        "rate_limit.exceeded",
        "Rate limit exceeded",
        path=request.url.path,
        client_ip=_client_key(request),
        limit=str(exc.limit.limit),
    )
    response = JSONResponse(
        status_code=429,
        content={
            "error": {
                "code": "rate_limit_exceeded",
                "message": "Слишком много запросов. Повторите попытку позже.",
            }
        },
    )
    request_id = getattr(request.state, "request_id", None)
    if request_id:
        response.headers["X-Request-ID"] = str(request_id)
    return response
