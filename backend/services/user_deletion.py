"""Хелпер физического удаления пользователей вместе с их зависимостями.

FK на ``users.id`` неоднородны: часть с ``ON DELETE CASCADE``
(refresh_tokens, dev_test_lobby_links), часть с ``SET NULL`` (images,
narrator), но ``players``, ``subscriptions`` и ``sessions.host_user_id`` —
без каскада, поэтому их надо снести вручную, иначе DELETE упрётся в FK.

Используется и при удалении юзера из админ-панели (DELETE /admin/users/{id}),
и при автоудалении синтетических игроков dev-test лобби вместе с сессией
(DELETE /admin/sessions/{id}).
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from models.player import Player
from models.session import Session as SessionModel
from models.subscription import Subscription
from models.user import User


async def delete_users_with_dependencies(
    db: AsyncSession,
    user_ids: Sequence[uuid.UUID],
) -> int:
    """Удаляет пользователей и зависимые записи в одной транзакции (без commit).

    Порядок важен из-за некаскадных FK:
    1. Сессии, где юзер — хост (DB-каскад снесёт их players/phases/events/links).
    2. Подписки юзера.
    3. Player-записи юзера (в чужих сессиях).
    4. Сами пользователи (refresh_tokens / dev_test_lobby_links уйдут каскадом,
       images / narrator-поля занулятся через SET NULL).

    Commit оставлен вызывающему — чтобы операцию можно было объединить с
    удалением сессии в одной транзакции. Возвращает число удалённых юзеров.
    """
    ids = list(user_ids)
    if not ids:
        return 0

    await db.execute(delete(SessionModel).where(SessionModel.host_user_id.in_(ids)))
    await db.execute(delete(Subscription).where(Subscription.user_id.in_(ids)))
    await db.execute(delete(Player).where(Player.user_id.in_(ids)))
    await db.execute(delete(User).where(User.id.in_(ids)))
    return len(ids)
