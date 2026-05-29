import React, { useCallback, useEffect, useState } from 'react';
import {
  adminSessionsApi,
  AdminSessionItem,
  ListParams,
} from '../../api/adminSessionsApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

const PAGE_SIZE = 100;

type StatusFilter = '' | 'waiting' | 'active' | 'finished' | 'active_all';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function statusBadgeColor(status: string, abandoned: boolean): string {
  if (abandoned) return '#e88a3a';
  if (status === 'waiting') return '#8c8f95';
  if (status === 'active') return '#5fa05f';
  if (status === 'finished') return '#6a6e74';
  return '#8c8f95';
}

export default function AdminSessionsPage() {
  const [sessions, setSessions] = useState<AdminSessionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState<'none' | 'abandoned' | 'synthetic'>('none');
  const [cleanupMsg, setCleanupMsg] = useState('');

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active_all');
  const [abandonedOnly, setAbandonedOnly] = useState(false);
  const [devTestOnly, setDevTestOnly] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params: ListParams = { limit: PAGE_SIZE };
    if (statusFilter) params.status = statusFilter as ListParams['status'];
    if (abandonedOnly) params.abandoned_only = true;
    if (devTestOnly) params.dev_test_lobby_only = true;
    adminSessionsApi
      .list(params)
      .then((res) => {
        setSessions(res.data.sessions);
        setTotal(res.data.total);
      })
      .catch((err) => {
        logger.warn('admin.sessions.load_failed', 'Failed to load sessions', {
          error: parseApiError(err),
        });
        setError(getApiErrorMessage(err) ?? 'Не удалось загрузить сессии');
      })
      .finally(() => setLoading(false));
  }, [statusFilter, abandonedOnly, devTestOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const handleClose = async (sessionId: string) => {
    if (!window.confirm('Закрыть сессию (status=finished)?')) return;
    setBusyId(sessionId);
    setError('');
    try {
      const res = await adminSessionsApi.close(sessionId);
      setSessions((arr) =>
        arr.map((s) => (s.id === sessionId ? res.data : s)),
      );
    } catch (err) {
      logger.warn('admin.sessions.close_failed', 'Failed to close session', {
        error: parseApiError(err),
        sessionId,
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось закрыть сессию');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (
      !window.confirm(
        'Удалить сессию НАВСЕГДА? Будут удалены все игроки, фазы, события. Это необратимо.',
      )
    )
      return;
    setBusyId(sessionId);
    setError('');
    try {
      await adminSessionsApi.remove(sessionId);
      setSessions((arr) => arr.filter((s) => s.id !== sessionId));
      setTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      logger.warn('admin.sessions.delete_failed', 'Failed to delete session', {
        error: parseApiError(err),
        sessionId,
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить сессию');
    } finally {
      setBusyId(null);
    }
  };

  const handleCleanupAbandoned = async () => {
    if (!window.confirm('Закрыть все зависшие сессии (status=finished)?')) return;
    setCleanupBusy('abandoned');
    setCleanupMsg('');
    setError('');
    try {
      const res = await adminSessionsApi.cleanupAbandoned();
      setCleanupMsg(`Закрыто сессий: ${res.data.affected}`);
      load();
    } catch (err) {
      logger.warn('admin.cleanup.abandoned_failed', 'Cleanup failed', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось выполнить cleanup');
    } finally {
      setCleanupBusy('none');
    }
  };

  const handleCleanupSynthetic = async () => {
    if (
      !window.confirm(
        'Удалить всех synthetic-юзеров (dev-test-lobby), не привязанных к активным сессиям?',
      )
    )
      return;
    setCleanupBusy('synthetic');
    setCleanupMsg('');
    setError('');
    try {
      const res = await adminSessionsApi.cleanupSynthetic();
      setCleanupMsg(`Удалено synthetic-юзеров: ${res.data.affected}`);
    } catch (err) {
      logger.warn('admin.cleanup.synthetic_failed', 'Cleanup failed', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось выполнить cleanup');
    } finally {
      setCleanupBusy('none');
    }
  };

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Активные сессии</h1>
          <p className="admin-page-header__subtitle">
            Список игровых сессий. Фильтры — по статусу, зависшим и dev-test-lobby.
            Действия: мягкое закрытие (status=finished), полное удаление и bulk-cleanup.
          </p>
        </div>
      </header>

      {error && <div className="admin-error-banner">{error}</div>}
      {cleanupMsg && <div className="admin-card" style={{ background: '#1f3a2a' }}>{cleanupMsg}</div>}

      {/* Фильтры */}
      <div className="admin-card">
        <div className="admin-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: '#8c8f95' }}>СТАТУС</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="">Все</option>
              <option value="active_all">Waiting + Active</option>
              <option value="waiting">Waiting</option>
              <option value="active">Active</option>
              <option value="finished">Finished</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={abandonedOnly}
              onChange={(e) => setAbandonedOnly(e.target.checked)}
            />
            <span>Только зависшие</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={devTestOnly}
              onChange={(e) => setDevTestOnly(e.target.checked)}
            />
            <span>Только dev-test-lobby</span>
          </label>
          <button className="admin-btn" onClick={load} disabled={loading}>
            {loading ? '...' : 'Обновить'}
          </button>
        </div>
        <div className="admin-row" style={{ marginTop: 12 }}>
          <button
            className="admin-btn"
            onClick={handleCleanupAbandoned}
            disabled={cleanupBusy !== 'none'}
          >
            {cleanupBusy === 'abandoned' ? '...' : 'Закрыть все зависшие'}
          </button>
          <button
            className="admin-btn"
            onClick={handleCleanupSynthetic}
            disabled={cleanupBusy !== 'none'}
          >
            {cleanupBusy === 'synthetic' ? '...' : 'Удалить осиротевших synthetic-юзеров'}
          </button>
        </div>
      </div>

      <div className="admin-card" style={{ overflowX: 'auto' }}>
        <div style={{ fontSize: 12, color: '#8c8f95', marginBottom: 8 }}>
          Всего: {total} · Показано: {sessions.length}
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Код</th>
              <th>Статус</th>
              <th>Игроки</th>
              <th>Хост</th>
              <th>Создана</th>
              <th>Последняя фаза</th>
              <th>Story</th>
              <th>Флаги</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className={s.is_abandoned ? 'row-abandoned' : ''}>
                <td>
                  <code>{s.code}</code>
                </td>
                <td>
                  <span
                    className="admin-pill"
                    style={{
                      background: statusBadgeColor(s.status, s.is_abandoned),
                      color: '#fff',
                    }}
                  >
                    {s.status}
                    {s.is_abandoned ? ' · ⚠' : ''}
                  </span>
                </td>
                <td>
                  {s.players_joined} / {s.player_count}
                </td>
                <td>
                  <div style={{ fontSize: 13 }}>{s.host_display_name}</div>
                  <div style={{ fontSize: 11, color: '#8c8f95' }}>{s.host_email}</div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(s.created_at)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(s.last_phase_at)}</td>
                <td>
                  {s.use_story_engine ? (
                    <span className="admin-pill admin-pill--variant">
                      story
                      {s.story_id ? '' : ' (no-id)'}
                    </span>
                  ) : (
                    <span style={{ color: '#8c8f95' }}>—</span>
                  )}
                </td>
                <td>
                  {s.is_dev_test_lobby && (
                    <span className="admin-pill">dev-test</span>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {s.status !== 'finished' && (
                    <button
                      className="admin-btn"
                      onClick={() => handleClose(s.id)}
                      disabled={busyId === s.id}
                      style={{ marginRight: 6 }}
                    >
                      Закрыть
                    </button>
                  )}
                  <button
                    className="admin-btn"
                    onClick={() => handleDelete(s.id)}
                    disabled={busyId === s.id}
                    style={{ background: '#c81e1e', color: '#fff' }}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
            {!loading && sessions.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', color: '#8c8f95', padding: 16 }}>
                  Нет сессий
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
