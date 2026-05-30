from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, Mock

import pytest

from services.user_deletion import delete_users_with_dependencies


@pytest.mark.asyncio
async def test_delete_users_with_dependencies_empty_is_noop() -> None:
    db = Mock()
    db.execute = AsyncMock()
    assert await delete_users_with_dependencies(db, []) == 0
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_users_with_dependencies_issues_all_deletes() -> None:
    db = Mock()
    db.execute = AsyncMock()
    ids = [uuid.uuid4(), uuid.uuid4()]

    deleted = await delete_users_with_dependencies(db, ids)

    assert deleted == 2
    # Sessions(host), subscriptions, players, users → ровно 4 DELETE-стейтмента.
    assert db.execute.await_count == 4
