"""promote initial admin (startsevkirill010101@gmail.com)

Хардкод-промоушен начального админа для narrator admin panel.
Прод-сервер закрыт от прямого SSH/SQL доступа, поэтому admin-флаг выдаётся
через миграцию: при следующем `alembic upgrade head` (entrypoint.sh)
указанному email выставляется ``is_admin=true``.

Идемпотентно: если юзера ещё нет в БД (не зарегистрировался) — UPDATE
просто ничего не сделает (rowcount=0), миграция всё равно зафиксируется
как применённая. Чтобы повторно повысить после возможной регистрации,
понадобится отдельная миграция.

Revision ID: 20260521_promote_initial_admin
Revises: 20260518_users_is_admin
Create Date: 2026-05-21
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "20260521_promote_initial_admin"
down_revision: Union[str, Sequence[str], None] = "20260518_users_is_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


ADMIN_EMAIL = "startsevkirill010101@gmail.com"


def upgrade() -> None:
    # LOWER(email) — на всякий случай, если юзер регнулся с другим регистром.
    # Колонка email хранится как есть (без normalize в auth-роутере).
    op.execute(
        f"UPDATE users SET is_admin = TRUE WHERE LOWER(email) = LOWER('{ADMIN_EMAIL}')"
    )


def downgrade() -> None:
    op.execute(
        f"UPDATE users SET is_admin = FALSE WHERE LOWER(email) = LOWER('{ADMIN_EMAIL}')"
    )
