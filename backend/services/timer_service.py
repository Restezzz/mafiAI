"""Сервис таймеров (asyncio.Task) по сессиям.

В продакшн-режиме таймеры пересоздаются после рестарта через recovery-сервис.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable

from core.logging import log_event, log_exception


logger = logging.getLogger(__name__)


class TimerService:
    def __init__(self):
        self._timers: dict[uuid.UUID, dict[str, asyncio.Task]] = {}

    async def start_timer(
        self,
        session_id: uuid.UUID,
        timer_name: str,
        seconds: int,
        callback: Callable[[], Awaitable[None]],
    ):
        await self.cancel_timer(session_id, timer_name)
        task = asyncio.create_task(self._run(session_id, timer_name, seconds, callback))
        self._timers.setdefault(session_id, {})[timer_name] = task
        log_event(logger, logging.DEBUG, "timer.started", "Timer started", session_id=str(session_id), timer_name=timer_name, seconds=seconds)

    async def cancel_timer(self, session_id: uuid.UUID, timer_name: str):
        timers = self._timers.get(session_id, {})
        task = timers.pop(timer_name, None)
        # Не отменяем задачу, изнутри которой нас вызвали: иначе resolver,
        # запущенный как сам callback таймера (await callback() в _run),
        # отменяет собственную задачу и ловит CancelledError на следующем
        # await (например, db.commit() в start_name_pick) — переход фазы
        # обрывается. Достаточно убрать таймер из реестра: _run и так
        # завершится сам после возврата из callback.
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()
            log_event(logger, logging.DEBUG, "timer.cancelled", "Timer cancelled", session_id=str(session_id), timer_name=timer_name)

    async def cancel_all(self, session_id: uuid.UUID):
        timers = self._timers.pop(session_id, {})
        for task in timers.values():
            if not task.done():
                task.cancel()
        if timers:
            log_event(logger, logging.DEBUG, "timer.cancelled_all", "All timers cancelled", session_id=str(session_id), timer_count=len(timers))

    async def cancel_all_sessions(self) -> int:
        """Отменяет таймеры всех активных сессий — для graceful shutdown (#20).

        Возвращает количество отменённых таймеров. Используется в @app.on_event("shutdown")
        чтобы не оставлять висящие asyncio.Task'и при SIGTERM от kubernetes/systemd.
        """
        cancelled = 0
        sessions = list(self._timers.keys())
        for sid in sessions:
            timers = self._timers.pop(sid, {})
            for task in timers.values():
                if not task.done():
                    task.cancel()
                    cancelled += 1
        if cancelled:
            log_event(
                logger,
                logging.INFO,
                "timer.cancelled_all_sessions",
                "All timers cancelled across all sessions",
                timer_count=cancelled,
                session_count=len(sessions),
            )
        return cancelled

    def has_timer(self, session_id: uuid.UUID, timer_name: str) -> bool:
        task = self._timers.get(session_id, {}).get(timer_name)
        return bool(task and not task.done())

    async def _run(self, session_id: uuid.UUID, timer_name: str, seconds: int, callback):
        try:
            await asyncio.sleep(seconds)
            await callback()
        except asyncio.CancelledError:
            pass
        except Exception:
            log_exception(logger, "timer.callback_failed", "Timer callback failed", session_id=str(session_id), timer_name=timer_name)
        finally:
            # Снимаем себя из реестра только если там всё ещё наша задача:
            # callback мог перезапустить таймер с тем же именем (новая задача),
            # и затирать его нельзя.
            timers = self._timers.get(session_id, {})
            if timers.get(timer_name) is asyncio.current_task():
                timers.pop(timer_name, None)


timer_service = TimerService()
