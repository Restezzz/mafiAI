"""Точка входа FastAPI-приложения."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from core.config import settings
from core.exceptions import GameError, game_error_handler
from core.logging import configure_logging, log_event, log_exception
from core.logging_middleware import RequestContextLoggingMiddleware
from core.rate_limit import limiter, rate_limit_exceeded_handler
from services.recovery_service import recovery_loop
from services.role_catalog import ensure_role_catalog
from services.story_seed import ensure_classic_mafia_story
from services.timer_service import timer_service


configure_logging(settings.APP_ENV, settings.LOG_LEVEL)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Жизненный цикл приложения (#20).

    Заменяет deprecated `@app.on_event("startup"/"shutdown")` единым контекстным
    менеджером. На startup поднимаем role catalog + recovery loop. На shutdown
    отменяем все таймеры и recovery, ждём корректного завершения.

    Без этого SIGTERM от kubernetes/systemd убивает воркер uvicorn принудительно
    через 30s timeout: висящие asyncio.sleep() в timer_service бросают
    CancelledError, callback'и могут не успеть откатиться → коррапт state.
    """
    await ensure_role_catalog()
    # Story Engine seed: идемпотентен (early-return если classic_mafia уже
    # в БД). Любая ошибка (например рассинхрон миграций story_engine_tables)
    # НЕ должна валить весь backend — иначе uvicorn падает и nginx отдаёт 502.
    # Логируем и продолжаем; gameplay по legacy-пути продолжает работать.
    try:
        await ensure_classic_mafia_story()
    except Exception:
        log_exception(
            logger,
            "app.story_seed_failed",
            "Failed to seed classic_mafia story — Story Engine may be unavailable",
        )
    recovery_task = asyncio.create_task(recovery_loop())
    log_event(logger, logging.INFO, "app.started", "Backend startup completed", app_env=settings.APP_ENV)

    try:
        yield
    finally:
        # 1. Останавливаем recovery, чтобы не пересоздавал таймеры в момент shutdown'а.
        recovery_task.cancel()
        try:
            await recovery_task
        except asyncio.CancelledError:
            pass
        except Exception:
            log_exception(logger, "app.shutdown.recovery_failed", "Recovery loop raised on shutdown")
        # 2. Отменяем все игровые таймеры (asyncio.sleep + callback'и).
        cancelled = await timer_service.cancel_all_sessions()
        log_event(
            logger,
            logging.INFO,
            "app.stopped",
            "Backend graceful shutdown completed",
            timers_cancelled=cancelled,
        )


app = FastAPI(title="AI-GameMaster", lifespan=lifespan)

# Mount хранилища аудио narrator'а. Любая ошибка здесь (нет прав на mkdir,
# volume не смонтирован, кривой AUDIO_STORAGE_ROOT) НЕ должна валить весь
# backend — иначе uvicorn падает при импорте main.py и nginx отдаёт 502
# на ВСЕ запросы, включая /auth/login. Логируем и пропускаем mount —
# фронт временно потеряет аудио, но core-функциональность останется живой.
try:
    settings.audio_storage_path.mkdir(parents=True, exist_ok=True)
    app.mount(
        "/audio",
        StaticFiles(directory=str(settings.audio_storage_path)),
        name="narrator_audio",
    )
except Exception:
    log_exception(
        logger,
        "app.audio_mount_failed",
        "Failed to mount /audio StaticFiles — narrator audio will be unavailable",
        audio_storage_root=str(settings.AUDIO_STORAGE_ROOT),
    )

# Mount хранилища картинок (карточки ролей, обложки сюжетов). Та же
# fail-soft логика, что и для /audio.
try:
    settings.image_storage_path.mkdir(parents=True, exist_ok=True)
    app.mount(
        "/images",
        StaticFiles(directory=str(settings.image_storage_path)),
        name="story_images",
    )
except Exception:
    log_exception(
        logger,
        "app.images_mount_failed",
        "Failed to mount /images StaticFiles — story images will be unavailable",
        image_storage_root=str(settings.IMAGE_STORAGE_ROOT),
    )

# Rate limiter: ставим до CORS и логирования, чтобы 429 уходил без полной обработки.
# Лимиты per-route задаются декоратором @limiter.limit(...) в роутерах.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    # Явный whitelist: с credentials=True wildcards в CORS считаются плохой
    # практикой даже когда CORSMiddleware их допускает. Открытый * заголовка
    # лишний раз светит surface поверх того, что нужно.
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Accept",
        "X-Request-ID",
        "X-Client-Request-ID",
    ],
    expose_headers=["X-Request-ID"],
)
app.add_middleware(RequestContextLoggingMiddleware)


@app.exception_handler(GameError)
async def _game_error_handler(request, exc: GameError):
    return await game_error_handler(request, exc)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request, exc: RequestValidationError):
    first_error = exc.errors()[0] if exc.errors() else {"loc": [], "msg": "Invalid input"}
    field = ".".join(str(loc) for loc in first_error.get("loc", []) if loc != "body")
    message = f"{field}: {first_error.get('msg', 'Invalid input')}".strip(": ")
    response = JSONResponse(
        status_code=400,
        content={"error": {"code": "validation_error", "message": message}},
    )
    request_id = getattr(request.state, "request_id", None)
    if request_id:
        response.headers["X-Request-ID"] = str(request_id)
    log_event(
        logger,
        logging.WARNING,
        "request.validation_failed",
        message,
        method=request.method,
        path=request.url.path,
    )
    return response


@app.exception_handler(Exception)
async def generic_error_handler(request, exc: Exception):
    response = JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "Внутренняя ошибка сервера"}},
    )
    request_id = getattr(request.state, "request_id", None)
    if request_id:
        response.headers["X-Request-ID"] = str(request_id)
    log_exception(
        logger,
        "request.unhandled_exception",
        "Unhandled backend exception",
        method=request.method,
        path=request.url.path,
    )
    return response


from api.routers.auth import router as auth_router
from api.routers.sessions import router as sessions_router
from api.routers.lobby import router as lobby_router
from api.routers.game import router as game_router
from api.routers.logs import router as logs_router
from api.routers.observability import router as observability_router
from api.routers.subscriptions import router as subscriptions_router
from api.routers.stories import router as stories_router
from api.routers.dev import router as dev_router
from api.routers.admin_users import router as admin_users_router
from api.websockets.ws import router as ws_router

app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(sessions_router, prefix="/api/sessions", tags=["sessions"])
app.include_router(lobby_router, prefix="/api/sessions", tags=["lobby"])
app.include_router(game_router, prefix="/api/sessions", tags=["game"])
app.include_router(logs_router, prefix="/api/logs", tags=["logs"])
app.include_router(observability_router, prefix="/api/observability", tags=["observability"])
app.include_router(subscriptions_router, prefix="/api/subscriptions", tags=["subscriptions"])
# /api/stories — публичный список активных сюжетов для lobby UI (этап 2.6).
# Изоляция по тому же паттерну что admin_stories: импорт делает SELECT при
# первом запросе, поэтому если миграция Story Engine не применена, упадёт
# не на startup а только при первом обращении (которое до миграций не
# случится).
app.include_router(stories_router, prefix="/api/stories", tags=["stories"])
# /api/admin/users/* — управление is_admin флагами других юзеров. Гейт require_admin.
app.include_router(admin_users_router, prefix="/api/admin", tags=["admin-users"])
# /api/admin/sessions/* + /api/admin/cleanup/* — hygiene-роутер.
# Регистрируется без изоляции: использует только базовые модели (Session,
# User, Player, GamePhase), которые есть с самой первой миграции.
from api.routers.admin_sessions import router as admin_sessions_router
app.include_router(admin_sessions_router, prefix="/api/admin", tags=["admin-sessions"])
# /api/admin/stories/* — Story Engine CRUD. Тот же изоляционный паттерн что и
# admin_narrator: ошибка импорта (например ещё не накатили story_engine_tables
# миграцию) логируется, но не валит uvicorn.
try:
    from api.routers.admin_stories import router as admin_stories_router
    app.include_router(admin_stories_router, prefix="/api/admin", tags=["admin-stories"])
except Exception:
    log_exception(
        logger,
        "app.admin_stories_disabled",
        "Failed to mount admin_stories router — Story Engine admin will be unavailable",
    )
# admin_narrator-роутер изолируем: его импорт тянет models.narrator + services
# narrator_*, которые требуют применённых миграций (narrator_tables, is_admin).
# Если миграции не накатились / схема рассинхронизирована — импорт упадёт и
# уронит весь uvicorn → nginx отдаст 502 на /auth/login. Логируем и пропускаем,
# admin-панель временно недоступна, остальное API работает.
try:
    from api.routers.admin_narrator import router as admin_narrator_router
    app.include_router(admin_narrator_router, prefix="/api/admin/narrator", tags=["admin-narrator"])
except Exception:
    log_exception(
        logger,
        "app.admin_narrator_disabled",
        "Failed to import admin_narrator router — admin panel will be unavailable",
    )
app.include_router(ws_router, prefix="/ws", tags=["ws"])
# /api/dev/* — синтетические тест-лобби. Эндпоинты гейтятся
# require_admin_or_dev_env: в production пускает только админов,
# в dev/test — любого залогиненного.
app.include_router(dev_router, prefix="/api/dev", tags=["dev"])


@app.get("/")
async def health():
    return {"status": "ok"}
