import React, { useEffect, useState } from 'react';
import { adminUsersApi, AdminUser } from '../../api/adminUsersApi';
import { useAuthStore } from '../../stores/authStore';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

const PAGE_SIZE = 50;

export default function AdminUsersPage() {
  const me = useAuthStore((s) => s.user);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Quick-form: promote-by-email.
  const [promoteEmail, setPromoteEmail] = useState('');
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [promoteError, setPromoteError] = useState('');
  const [promoteSuccess, setPromoteSuccess] = useState('');

  // Новый поиск всегда сбрасывает на первую страницу — иначе offset мог бы
  // указывать за пределы отфильтрованного набора.
  useEffect(() => {
    setPage(0);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    // 250ms debounce — не дёргаем бек на каждое нажатие клавиши.
    const t = setTimeout(() => {
      adminUsersApi
        .list({ q: query.trim() || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
        .then((res) => {
          if (cancelled) return;
          setUsers(res.data.users);
          setTotal(res.data.total);
        })
        .catch((err) => {
          if (cancelled) return;
          logger.warn('admin.users.load_failed', 'Failed to load users', {
            error: parseApiError(err),
          });
          setError(getApiErrorMessage(err) ?? 'Не удалось загрузить пользователей');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, page]);

  const upsertUser = (updated: AdminUser) => {
    setUsers((arr) => {
      const found = arr.find((u) => u.id === updated.id);
      return found ? arr.map((u) => (u.id === updated.id ? updated : u)) : arr;
    });
  };

  const handleToggle = async (user: AdminUser) => {
    setBusyId(user.id);
    setError('');
    try {
      const res = user.is_admin
        ? await adminUsersApi.demote(user.id)
        : await adminUsersApi.promote(user.id);
      upsertUser(res.data);
    } catch (err) {
      logger.warn('admin.users.toggle_failed', 'Failed to toggle admin role', {
        error: parseApiError(err),
        userId: user.id,
      });
      setError(getApiErrorMessage(err) ?? 'Операция не удалась');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (user: AdminUser) => {
    const ok = window.confirm(
      `Удалить пользователя ${user.email}? Будут удалены его сессии (как хоста), ` +
        'подписки и участия в играх. Действие необратимо.',
    );
    if (!ok) return;
    setBusyId(user.id);
    setError('');
    try {
      await adminUsersApi.remove(user.id);
      setUsers((arr) => arr.filter((u) => u.id !== user.id));
      setTotal((t) => Math.max(0, t - 1));
    } catch (err) {
      logger.warn('admin.users.delete_failed', 'Failed to delete user', {
        error: parseApiError(err),
        userId: user.id,
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить пользователя');
    } finally {
      setBusyId(null);
    }
  };

  const handlePromoteByEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setPromoteError('');
    setPromoteSuccess('');
    const email = promoteEmail.trim();
    if (!email) return;
    setPromoteBusy(true);
    try {
      const res = await adminUsersApi.promoteByEmail(email);
      setPromoteSuccess(`${res.data.email} теперь админ`);
      setPromoteEmail('');
      upsertUser(res.data);
    } catch (err) {
      logger.warn('admin.users.promote_by_email_failed', 'Failed to promote by email', {
        error: parseApiError(err),
      });
      setPromoteError(getApiErrorMessage(err) ?? 'Не удалось выдать роль');
    } finally {
      setPromoteBusy(false);
    }
  };

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Пользователи</h1>
          <p className="admin-page-header__subtitle">
            Выдавайте и снимайте роль администратора. Юзер должен быть зарегистрирован
            (если нет — попросите его создать аккаунт обычной кнопкой Sign Up).
          </p>
        </div>
      </header>

      <div className="admin-stack">
        <div className="admin-card">
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>Выдать админа по email</h3>
          <form onSubmit={handlePromoteByEmail} className="admin-row" style={{ alignItems: 'center' }}>
            <input
              type="email"
              value={promoteEmail}
              onChange={(e) => setPromoteEmail(e.target.value)}
              placeholder="user@example.com"
              className="admin-input"
              style={{ flex: '1 1 280px', minWidth: 240, width: 'auto' }}
              disabled={promoteBusy}
              autoComplete="off"
            />
            <button
              type="submit"
              className="admin-btn admin-btn--primary"
              disabled={promoteBusy || !promoteEmail.trim()}
            >
              {promoteBusy ? 'Выдаём…' : 'Сделать админом'}
            </button>
          </form>
          {promoteError && (
            <div className="admin-error-banner" style={{ marginTop: 12, marginBottom: 0 }}>
              {promoteError}
            </div>
          )}
          {promoteSuccess && (
            <div className="admin-success-banner" style={{ marginTop: 12 }}>
              {promoteSuccess}
            </div>
          )}
        </div>

        <div className="admin-card">
          <div className="admin-row" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по email или нику…"
              className="admin-input"
              style={{ flex: '1 1 280px', minWidth: 240, width: 'auto' }}
              autoComplete="off"
            />
            <span style={{ color: '#8c8f95', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
              показано {users.length} из {total}
            </span>
          </div>

          {loading && <div className="admin-loading">Загрузка…</div>}
          {error && <div className="admin-error-banner">{error}</div>}

          {!loading && !error && users.length === 0 && (
            <div style={{ padding: 24, color: '#8c8f95', textAlign: 'center' }}>
              Пользователи не найдены
            </div>
          )}

          {!loading && users.length > 0 && (
            <div className="admin-users-list">
              {users.map((u) => {
                const isMe = u.id === me?.user_id;
                const isBusy = busyId === u.id;
                const cannotDemoteSelf = isMe && u.is_admin;
                return (
                  <div key={u.id} className="admin-users-list__row">
                    <div className="admin-users-list__main">
                      <div className="admin-users-list__email">
                        {u.email}
                        {isMe && (
                          <span className="admin-pill" style={{ marginLeft: 8 }}>
                            вы
                          </span>
                        )}
                      </div>
                      <div className="admin-users-list__sub">{u.display_name}</div>
                    </div>
                    <div className="admin-users-list__role">
                      {u.is_admin ? (
                        <span className="admin-pill admin-pill--variant">админ</span>
                      ) : (
                        <span className="admin-pill">user</span>
                      )}
                    </div>
                    <div className="admin-row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                      <button
                        type="button"
                        className={`admin-btn${u.is_admin ? '' : ' admin-btn--primary'}`}
                        disabled={isBusy || cannotDemoteSelf}
                        onClick={() => handleToggle(u)}
                        title={cannotDemoteSelf ? 'Нельзя снять админа с себя' : undefined}
                      >
                        {isBusy ? '…' : u.is_admin ? 'Снять админа' : 'Сделать админом'}
                      </button>
                      <button
                        type="button"
                        className="admin-btn admin-btn--danger"
                        disabled={isBusy || isMe}
                        onClick={() => handleDelete(u)}
                        title={isMe ? 'Нельзя удалить себя' : 'Удалить пользователя'}
                      >
                        {isBusy ? '…' : 'Удалить'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!loading && !error && total > PAGE_SIZE && (
            <div
              className="admin-row"
              style={{ marginTop: 12, alignItems: 'center', justifyContent: 'center', gap: 12 }}
            >
              <button
                type="button"
                className="admin-btn"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                ← Назад
              </button>
              <span style={{ color: '#8c8f95', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                стр. {page + 1} из {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              </span>
              <button
                type="button"
                className="admin-btn"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                Вперёд →
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
