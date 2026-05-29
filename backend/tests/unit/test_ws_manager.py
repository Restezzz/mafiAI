from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest

from services.ws_manager import ConnectionManager


@pytest.fixture
def cm():
    return ConnectionManager()


@pytest.fixture
def sid():
    return uuid.uuid4()


def _mock_ws():
    ws = AsyncMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


def _assert_sent(send_json: AsyncMock, expected_subset: dict) -> None:
    """Кадр содержит ожидаемые поля + штамп server_now (значение не фиксируем)."""
    send_json.assert_awaited_once()
    sent = send_json.await_args.args[0]
    for key, value in expected_subset.items():
        assert sent[key] == value
    assert "server_now" in sent


@pytest.mark.asyncio
async def test_connect_accepts_and_registers(cm, sid):
    uid = uuid.uuid4()
    ws = _mock_ws()
    await cm.connect(sid, uid, ws)
    ws.accept.assert_awaited_once()


@pytest.mark.asyncio
async def test_disconnect_removes_user(cm, sid):
    uid = uuid.uuid4()
    ws = _mock_ws()
    await cm.connect(sid, uid, ws)
    await cm.disconnect(sid, uid)
    # session should be cleaned up since last user left
    assert sid not in cm._connections


@pytest.mark.asyncio
async def test_disconnect_nonexistent_no_error(cm, sid):
    await cm.disconnect(sid, uuid.uuid4())


@pytest.mark.asyncio
async def test_send_to_session_broadcasts(cm, sid):
    u1, u2 = uuid.uuid4(), uuid.uuid4()
    ws1, ws2 = _mock_ws(), _mock_ws()
    await cm.connect(sid, u1, ws1)
    await cm.connect(sid, u2, ws2)

    await cm.send_to_session(sid, {"type": "test"})
    _assert_sent(ws1.send_json, {"type": "test"})
    _assert_sent(ws2.send_json, {"type": "test"})


@pytest.mark.asyncio
async def test_send_to_session_handles_broken_ws(cm, sid):
    u1, u2 = uuid.uuid4(), uuid.uuid4()
    ws1, ws2 = _mock_ws(), _mock_ws()
    ws1.send_json.side_effect = RuntimeError("broken")
    await cm.connect(sid, u1, ws1)
    await cm.connect(sid, u2, ws2)

    await cm.send_to_session(sid, {"type": "test"})
    ws2.send_json.assert_awaited_once()
    # Stale connection should be auto-removed.
    assert u1 not in cm._connections.get(sid, {})
    assert u2 in cm._connections[sid]


@pytest.mark.asyncio
async def test_send_to_session_empty(cm, sid):
    await cm.send_to_session(sid, {"type": "test"})  # no error


@pytest.mark.asyncio
async def test_send_to_user_delivers(cm, sid):
    uid = uuid.uuid4()
    ws = _mock_ws()
    await cm.connect(sid, uid, ws)
    await cm.send_to_user(sid, uid, {"type": "direct"})
    _assert_sent(ws.send_json, {"type": "direct"})


@pytest.mark.asyncio
async def test_send_to_user_unknown_no_error(cm, sid):
    await cm.send_to_user(sid, uuid.uuid4(), {"type": "direct"})


@pytest.mark.asyncio
async def test_close_connection(cm, sid):
    uid = uuid.uuid4()
    ws = _mock_ws()
    await cm.connect(sid, uid, ws)
    await cm.close_connection(sid, uid, code=4001)
    ws.close.assert_awaited_once_with(code=4001)


@pytest.mark.asyncio
async def test_close_connection_exception_swallowed(cm, sid):
    uid = uuid.uuid4()
    ws = _mock_ws()
    ws.close.side_effect = RuntimeError("fail")
    await cm.connect(sid, uid, ws)
    await cm.close_connection(sid, uid)  # no error


@pytest.mark.asyncio
async def test_close_session_all(cm, sid):
    u1, u2 = uuid.uuid4(), uuid.uuid4()
    ws1, ws2 = _mock_ws(), _mock_ws()
    await cm.connect(sid, u1, ws1)
    await cm.connect(sid, u2, ws2)

    await cm.close_session(sid, code=4002)
    ws1.close.assert_awaited_once_with(code=4002)
    ws2.close.assert_awaited_once_with(code=4002)
    assert sid not in cm._connections


@pytest.mark.asyncio
async def test_send_to_user_removes_stale(cm, sid):
    uid = uuid.uuid4()
    ws = _mock_ws()
    ws.send_json.side_effect = RuntimeError("broken")
    await cm.connect(sid, uid, ws)

    await cm.send_to_user(sid, uid, {"type": "direct"})
    assert uid not in cm._connections.get(sid, {})


@pytest.mark.asyncio
async def test_close_session_nonexistent_no_error(cm, sid):
    await cm.close_session(sid)
