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

echo "[entrypoint] Starting uvicorn (workers=${WORKERS}, host=${HOST}, port=${PORT})..."
exec uv run uvicorn main:app \
    --host "${HOST}" \
    --port "${PORT}" \
    --workers "${WORKERS}" \
    --log-level "${LOG_LEVEL}" \
    --proxy-headers \
    --forwarded-allow-ips='*'
