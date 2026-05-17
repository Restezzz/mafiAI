"""WebSocket endpoint для push-событий сессии.

Подключение: `/ws/sessions/{session_id}?token={access_token}`
WS используется для синхронизации и триггеров озвучки; действия игроки отправляют через REST.

Heartbeat:
- Сервер шлёт `ping` каждые `WS_PING_INTERVAL_SECONDS` секунд тишины от клиента.
- Если за `WS_PONG_TIMEOUT_SECONDS` секунд клиент не прислал ничего (включая pong),
  соединение закрывается с кодом 4008 — клиент через onclose-обработчик
  переподключится через бэкофф.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

from fastapi import APIRouter, Query, WebSocket
from fastapi.websockets import WebSocketDisconnect
from jose import JWTError
from sqlalchemy import select

from core.database import async_session_factory
from core.logging import log_event, log_exception, set_log_context
from models.player import Player
from services.auth_service import decode_access_token
from services.ws_manager import ws_manager


logger = logging.getLogger(__name__)
router = APIRouter()

_PONG_RESPONSE = {"type": "pong", "payload": {}}
_PING_FRAME = {"type": "ping", "payload": {}}

WS_PING_INTERVAL_SECONDS = 30.0
WS_PONG_TIMEOUT_SECONDS = 60.0
WS_CLOSE_CODE_PONG_TIMEOUT = 4008


@router.websocket("/sessions/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    session_id: uuid.UUID,
    token: str = Query(...),
):
    try:
        payload = decode_access_token(token)
    except JWTError:
        log_event(logger, logging.WARNING, "ws.invalid_message", "WebSocket token decode failed", session_id=str(session_id))
        await websocket.close(code=4001)
        return

    try:
        user_id = uuid.UUID(payload["sub"])
    except Exception:
        log_event(logger, logging.WARNING, "ws.invalid_message", "WebSocket user id is invalid", session_id=str(session_id))
        await websocket.close(code=4001)
        return
    set_log_context(session_id=str(session_id), user_id=str(user_id), source="backend")

    async with async_session_factory() as db:
        player = await db.scalar(
            select(Player.id).where(Player.session_id == session_id, Player.user_id == user_id)
        )
    if not player:
        log_event(logger, logging.WARNING, "ws.invalid_message", "WebSocket connection rejected for non-player", session_id=str(session_id), user_id=str(user_id))
        await websocket.close(code=4003)
        return

    await ws_manager.connect(session_id, user_id, websocket)

    last_seen = time.monotonic()
    try:
        while True:
            try:
                data = await asyncio.wait_for(
                    websocket.receive_json(),
                    timeout=WS_PING_INTERVAL_SECONDS,
                )
            except asyncio.TimeoutError:
                # Тишина от клиента дольше PING_INTERVAL — проверяем, не «зомби» ли он.
                if time.monotonic() - last_seen > WS_PONG_TIMEOUT_SECONDS:
                    log_event(
                        logger,
                        logging.WARNING,
                        "ws.pong_timeout",
                        "WebSocket pong timeout, closing connection",
                        session_id=str(session_id),
                        user_id=str(user_id),
                    )
                    try:
                        await websocket.close(code=WS_CLOSE_CODE_PONG_TIMEOUT)
                    except Exception:
                        pass
                    break
                # Шлём ping; если send упадёт — выходим, в finally дисконнект.
                try:
                    await websocket.send_json(_PING_FRAME)
                except Exception:
                    break
                continue

            # Любое сообщение от клиента считаем признаком жизни.
            last_seen = time.monotonic()
            msg_type = data.get("type") if isinstance(data, dict) else None
            if msg_type == "ping":
                await websocket.send_json(_PONG_RESPONSE)
            elif msg_type == "pong":
                # Ответ на наш ping — last_seen уже обновлён.
                pass
            else:
                log_event(
                    logger,
                    logging.WARNING,
                    "ws.invalid_message",
                    "Unexpected inbound websocket message",
                    session_id=str(session_id),
                    user_id=str(user_id),
                    payload=data,
                )
    except WebSocketDisconnect:
        pass
    except Exception:
        log_exception(logger, "ws.loop_failed", "WebSocket loop failed", session_id=str(session_id), user_id=str(user_id))
    finally:
        await ws_manager.disconnect(session_id, user_id)
