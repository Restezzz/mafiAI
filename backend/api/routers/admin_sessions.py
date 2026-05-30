"""Admin endpoints для управления игровыми сессиями (hygiene).

Все эндпоинты гейтированы ``require_admin``. Содержит:
- GET /sessions — список с фильтрами (статус, abandoned, dev_test_lobby)
- POST /sessions/{id}/close — корректное завершение (status=finished, ended_at)
- DELETE /sessions/{id} — физическое удаление (cascade)
- POST /cleanup/abandoned-sessions — bulk-close зависших сессий
- POST /cleanup/synthetic-users — удалить осиротевших synthetic-юзеров
  (созданы dev_test_lobby_service: email LIKE 'dev.%@local.test')

Под "abandoned" понимается:
- status='waiting' + created_at < now - 24h (никто не запустил игру)
- status='active' + последняя GamePhase started_at < now - 6h (зависла)
"""
from __future__ import annotations

import logging
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, require_admin
from core.exceptions import GameError
from core.logging import log_event
from core.utils import utc_now
from models.dev_test_lobby_link import DevTestLobbyLink
from models.game_phase import GamePhase
from models.player import Player
from models.session import Session as SessionModel
from models.user import User
from services.user_deletion import delete_users_with_dependencies


logger = logging.getLogger(__name__)

router = APIRouter()


# Пороговые значения «зависшей» сессии. Можно вынести в settings/env позже.
WAITING_ABANDONED_HOURS = 24
ACTIVE_ABANDONED_HOURS = 6
SYNTHETIC_EMAIL_PATTERN = "dev.%@local.test"


# ---------------------------------------------------------------------------
# Pydantic схемы
# ---------------------------------------------------------------------------


class AdminSessionItem(BaseModel):
    id: str
    code: str
    status: str
    player_count: int
    players_joined: int
    host_user_id: str
    host_email: str
    host_display_name: str
    use_story_engine: bool
    story_id: str | None
    is_dev_test_lobby: bool
    created_at: str
    ended_at: str | None
    last_phase_at: str | None
    is_abandoned: bool


class AdminSessionsListResponse(BaseModel):
    sessions: list[AdminSessionItem]
    total: int


class CleanupResult(BaseModel):
    affected: int
    ids: list[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_abandoned(
    status: str,
    created_at,
    last_phase_at,
    now,
) -> bool:
    """Бизнес-логика «зависшей» сессии (см. модуль docstring)."""
    if status == "waiting":
        return created_at < now - timedelta(hours=WAITING_ABANDONED_HOURS)
    if status == "active":
        # Если ни одной фазы нет — берём created_at как fallback (что-то
        # очень странное: gameApi.start не отработал, но статус active).
        anchor = last_phase_at or created_at
        return anchor < now - timedelta(hours=ACTIVE_ABANDONED_HOURS)
    return False


async def _load_session_rows(
    db: AsyncSession,
    status: str | None,
    abandoned_only: bool,
    dev_test_lobby_only: bool,
    limit: int,
    offset: int,
):
    """Загружает joined-список сессий с агрегатами.

    Возвращает (items, total). Агрегаты:
    - players_joined = count(players)
    - last_phase_at = max(game_phases.started_at)
    """
    # Подзапрос: количество игроков в сессии.
    players_subq = (
        select(Player.session_id, func.count(Player.id).label("players_joined"))
        .group_by(Player.session_id)
        .subquery()
    )
    # Подзапрос: время последней фазы.
    last_phase_subq = (
        select(GamePhase.session_id, func.max(GamePhase.started_at).label("last_phase_at"))
        .group_by(GamePhase.session_id)
        .subquery()
    )

    stmt = (
        select(
            SessionModel,
            User,
            func.coalesce(players_subq.c.players_joined, 0).label("players_joined"),
            last_phase_subq.c.last_phase_at,
        )
        .join(User, User.id == SessionModel.host_user_id)
        .outerjoin(players_subq, players_subq.c.session_id == SessionModel.id)
        .outerjoin(last_phase_subq, last_phase_subq.c.session_id == SessionModel.id)
    )

    conditions = []
    if status == "active_all":
        conditions.append(SessionModel.status.in_(["waiting", "active"]))
    elif status in ("waiting", "active", "finished"):
        conditions.append(SessionModel.status == status)

    if dev_test_lobby_only:
        # JSONB поле settings.dev_test_lobby == true
        conditions.append(SessionModel.settings["dev_test_lobby"].astext == "true")

    if conditions:
        stmt = stmt.where(and_(*conditions))

    # Сортировка: свежие первыми.
    stmt = stmt.order_by(SessionModel.created_at.desc())

    # Полный count (без limit/offset, для total).
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(await db.scalar(count_stmt) or 0)

    stmt = stmt.limit(limit).offset(offset)

    rows = (await db.execute(stmt)).all()

    now = utc_now()
    items: list[AdminSessionItem] = []
    for sess, host, players_joined, last_phase_at in rows:
        abandoned = _is_abandoned(sess.status, sess.created_at, last_phase_at, now)
        if abandoned_only and not abandoned:
            # total в этом случае не точный, но это OK для UI: hint, что
            # фильтр применён. Серверной пагинации по abandoned не делаем
            # ради простоты (offset/limit применился ДО фильтра).
            continue
        items.append(
            AdminSessionItem(
                id=str(sess.id),
                code=sess.code,
                status=sess.status,
                player_count=int(sess.player_count),
                players_joined=int(players_joined),
                host_user_id=str(host.id),
                host_email=host.email,
                host_display_name=host.display_name,
                use_story_engine=bool((sess.settings or {}).get("use_story_engine") is True),
                story_id=str(sess.story_id) if sess.story_id else None,
                is_dev_test_lobby=bool((sess.settings or {}).get("dev_test_lobby") is True),
                created_at=sess.created_at.isoformat(),
                ended_at=sess.ended_at.isoformat() if sess.ended_at else None,
                last_phase_at=last_phase_at.isoformat() if last_phase_at else None,
                is_abandoned=abandoned,
            )
        )
    return items, total


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/sessions", response_model=AdminSessionsListResponse)
async def list_sessions(
    status: str | None = Query(
        default=None,
        description=(
            "Фильтр статуса: waiting | active | finished | active_all "
            "(waiting+active). По умолчанию все."
        ),
    ),
    abandoned_only: bool = Query(default=False),
    dev_test_lobby_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminSessionsListResponse:
    """Список сессий с агрегатами и флагом is_abandoned."""
    items, total = await _load_session_rows(
        db,
        status=status,
        abandoned_only=abandoned_only,
        dev_test_lobby_only=dev_test_lobby_only,
        limit=limit,
        offset=offset,
    )
    return AdminSessionsListResponse(sessions=items, total=total)


@router.post("/sessions/{session_id}/close", response_model=AdminSessionItem)
async def close_session(
    session_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminSessionItem:
    """Мягкое закрытие: status=finished, ended_at=now(). Идемпотентно."""
    sess = await db.get(SessionModel, session_id)
    if sess is None:
        raise GameError(404, "session_not_found", "Сессия не найдена")
    if sess.status == "finished":
        # Идемпотентно: возвращаем как есть.
        pass
    else:
        sess.status = "finished"
        sess.ended_at = utc_now()
        await db.commit()
        log_event(
            logger,
            logging.INFO,
            "admin.session.closed",
            "Admin closed session",
            session_id=str(session_id),
            admin_id=str(admin.id),
        )

    host = await db.get(User, sess.host_user_id)
    players_joined = int(
        await db.scalar(
            select(func.count(Player.id)).where(Player.session_id == sess.id)
        )
        or 0
    )
    last_phase_at = await db.scalar(
        select(func.max(GamePhase.started_at)).where(GamePhase.session_id == sess.id)
    )
    return AdminSessionItem(
        id=str(sess.id),
        code=sess.code,
        status=sess.status,
        player_count=int(sess.player_count),
        players_joined=players_joined,
        host_user_id=str(sess.host_user_id),
        host_email=host.email if host else "",
        host_display_name=host.display_name if host else "",
        use_story_engine=bool((sess.settings or {}).get("use_story_engine") is True),
        story_id=str(sess.story_id) if sess.story_id else None,
        is_dev_test_lobby=bool((sess.settings or {}).get("dev_test_lobby") is True),
        created_at=sess.created_at.isoformat(),
        ended_at=sess.ended_at.isoformat() if sess.ended_at else None,
        last_phase_at=last_phase_at.isoformat() if last_phase_at else None,
        is_abandoned=False,
    )


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Физическое удаление сессии. Cascade удалит players, phases, events.

    Дополнительно сносим синтетических игроков dev-test лобби (их User-записи),
    которые иначе остаются «висеть» в списке пользователей админки как реальные
    аккаунты. Хост (bootstrap_key='host') — реальный админ, его не трогаем.
    """
    sess = await db.get(SessionModel, session_id)
    if sess is None:
        raise GameError(404, "session_not_found", "Сессия не найдена")

    # Собираем id синтетических игроков ДО удаления сессии — dev_test_lobby_links
    # уйдут каскадом вместе с ней. email LIKE pattern + не-админ как доп. защита,
    # чтобы случайно не удалить реального юзера.
    synthetic_user_ids = list(
        (
            await db.scalars(
                select(DevTestLobbyLink.user_id)
                .join(User, User.id == DevTestLobbyLink.user_id)
                .where(
                    DevTestLobbyLink.session_id == session_id,
                    DevTestLobbyLink.bootstrap_key != "host",
                    User.email.like(SYNTHETIC_EMAIL_PATTERN),
                    User.is_admin.is_(False),
                )
            )
        ).all()
    )

    await db.delete(sess)
    deleted_users = await delete_users_with_dependencies(db, synthetic_user_ids)
    await db.commit()
    log_event(
        logger,
        logging.INFO,
        "admin.session.deleted",
        "Admin deleted session",
        session_id=str(session_id),
        admin_id=str(admin.id),
        synthetic_users_deleted=deleted_users,
    )
    return {
        "deleted": True,
        "id": str(session_id),
        "synthetic_users_deleted": deleted_users,
    }


@router.post("/cleanup/abandoned-sessions", response_model=CleanupResult)
async def cleanup_abandoned_sessions(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CleanupResult:
    """Bulk закрытие зависших сессий.

    Атомарность: одна транзакция на все сессии. Если хоть одна упала —
    откатываем все изменения (raise GameError).
    """
    now = utc_now()
    waiting_cutoff = now - timedelta(hours=WAITING_ABANDONED_HOURS)
    active_cutoff = now - timedelta(hours=ACTIVE_ABANDONED_HOURS)

    # Active с последней фазой раньше cutoff (или вообще без фаз). Делаем
    # двух-шаговую проверку: сначала active без подходящей фазы.
    last_phase_subq = (
        select(GamePhase.session_id, func.max(GamePhase.started_at).label("last_phase_at"))
        .group_by(GamePhase.session_id)
        .subquery()
    )
    stmt = (
        select(SessionModel)
        .outerjoin(last_phase_subq, last_phase_subq.c.session_id == SessionModel.id)
        .where(
            or_(
                and_(
                    SessionModel.status == "waiting",
                    SessionModel.created_at < waiting_cutoff,
                ),
                and_(
                    SessionModel.status == "active",
                    or_(
                        last_phase_subq.c.last_phase_at < active_cutoff,
                        and_(
                            last_phase_subq.c.last_phase_at.is_(None),
                            SessionModel.created_at < active_cutoff,
                        ),
                    ),
                ),
            )
        )
    )
    sessions = (await db.scalars(stmt)).all()

    ids: list[str] = []
    for sess in sessions:
        sess.status = "finished"
        sess.ended_at = now
        ids.append(str(sess.id))

    if ids:
        await db.commit()
        log_event(
            logger,
            logging.INFO,
            "admin.cleanup.abandoned_sessions",
            "Closed abandoned sessions",
            count=len(ids),
            admin_id=str(admin.id),
        )

    return CleanupResult(affected=len(ids), ids=ids)


@router.post("/cleanup/synthetic-users", response_model=CleanupResult)
async def cleanup_synthetic_users(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CleanupResult:
    """Удаляет synthetic-юзеров (email LIKE 'dev.%@local.test'), у которых
    нет активных сессий-партиций (players в waiting/active сессиях).

    Если synthetic-юзер всё ещё привязан к finished-сессии, он удаляется
    через ON DELETE caskade? — нет, FK на User не каскадные. Поэтому мы
    сначала удаляем Player-записи (вручную, чтобы не нарушить FK), а
    потом самого User'а.

    Безопасность: не трогаем юзеров с is_admin=True (на случай если кто-то
    создал админа с похожим email).
    """
    # 1. Кандидаты: synthetic email, не админ.
    candidates_stmt = select(User).where(
        User.email.like(SYNTHETIC_EMAIL_PATTERN),
        User.is_admin.is_(False),
    )
    candidates = (await db.scalars(candidates_stmt)).all()
    if not candidates:
        return CleanupResult(affected=0, ids=[])

    # 2. Какие из них имеют активные сессии (waiting/active)?
    candidate_ids = [u.id for u in candidates]
    active_players_stmt = (
        select(Player.user_id)
        .join(SessionModel, SessionModel.id == Player.session_id)
        .where(
            Player.user_id.in_(candidate_ids),
            SessionModel.status.in_(["waiting", "active"]),
        )
        .distinct()
    )
    active_user_ids = set((await db.scalars(active_players_stmt)).all())

    to_delete = [u for u in candidates if u.id not in active_user_ids]
    if not to_delete:
        return CleanupResult(affected=0, ids=[])

    to_delete_ids = [u.id for u in to_delete]

    # 3. Удаляем все Player-записи этих юзеров (FK без ON DELETE CASCADE
    # на users.id → cascade ручной).
    await db.execute(delete(Player).where(Player.user_id.in_(to_delete_ids)))
    # 4. Удаляем сами User'ы.
    await db.execute(delete(User).where(User.id.in_(to_delete_ids)))
    await db.commit()

    log_event(
        logger,
        logging.INFO,
        "admin.cleanup.synthetic_users",
        "Deleted synthetic users",
        count=len(to_delete_ids),
        admin_id=str(admin.id),
    )

    return CleanupResult(
        affected=len(to_delete_ids), ids=[str(u) for u in to_delete_ids]
    )
