#!/bin/sh
# ============================================================
# Production entrypoint:
#   1) Применяем миграции Alembic (idempotent — повторный запуск ничего
#      не сломает, alembic сам skip'нет уже применённые ревизии).
#   2) Запускаем uvicorn в production-режиме без --reload.
#
# При ошибке миграции — выходим с ненулевым кодом, чтобы compose
# увидел падение и перезапустил/остановил контейнер согласно restart-policy.
# ============================================================
set -eu

WORKERS="${UVICORN_WORKERS:-1}"
HOST="${UVICORN_HOST:-0.0.0.0}"
PORT="${UVICORN_PORT:-8000}"
LOG_LEVEL="${UVICORN_LOG_LEVEL:-info}"

echo "[entrypoint] Running alembic migrations..."
uv run alembic upgrade head

# Идемпотентный сид narrator'а (триггеры + аудиотека) из audio_manifest.json.
# Повторный прогон пропускает уже существующие записи (match по slug/filename),
# поэтому безопасно гонять на каждом старте/деплое. Выключается
# SEED_NARRATOR_ON_START=0. НЕ фатально: ошибка сида логируется, но не валит
# backend (иначе пустой триггер/недоступный mp3 уронил бы весь сервис).
if [ "${SEED_NARRATOR_ON_START:-0}" = "1" ]; then
    SEED_AUDIO_DIR="${NARRATOR_SEED_AUDIO_DIR:-/seed_audio}"
    echo "[entrypoint] Seeding narrator triggers/audio (src=${SEED_AUDIO_DIR})..."
    if uv run python scripts/migrate_narrator_to_db.py --audio-src "${SEED_AUDIO_DIR}"; then
        echo "[entrypoint] Narrator seed done."
    else
        echo "[entrypoint] WARNING: narrator seed failed — continuing startup." >&2
    fi
fi

echo "[entrypoint] Starting uvicorn (workers=${WORKERS}, host=${HOST}, port=${PORT})..."
exec uv run uvicorn main:app \
    --host "${HOST}" \
    --port "${PORT}" \
    --workers "${WORKERS}" \
    --log-level "${LOG_LEVEL}" \
    --proxy-headers \
    --forwarded-allow-ips='*'
