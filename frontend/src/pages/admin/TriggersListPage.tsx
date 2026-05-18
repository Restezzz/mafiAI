import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { Trigger, TriggerKind } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

type KindFilter = 'all' | TriggerKind;

export default function TriggersListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const groupFilter = searchParams.get('group') ?? 'all';
  const kindFilter = (searchParams.get('kind') ?? 'all') as KindFilter;

  useEffect(() => {
    let cancelled = false;
    adminNarratorApi
      .listTriggers()
      .then(({ data }) => {
        if (!cancelled) setTriggers(data.triggers);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.warn('admin.triggers.list_failed', 'Failed to load triggers', {
          error: parseApiError(err),
        });
        setError(getApiErrorMessage(err) ?? 'Не удалось загрузить триггеры');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const t of triggers) set.add(t.group_key);
    return Array.from(set).sort();
  }, [triggers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return triggers
      .filter((t) => groupFilter === 'all' || t.group_key === groupFilter)
      .filter((t) => kindFilter === 'all' || t.kind === kindFilter)
      .filter((t) => {
        if (!q) return true;
        return (
          t.slug.toLowerCase().includes(q) ||
          t.label.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.group_key.localeCompare(b.group_key) || a.slug.localeCompare(b.slug));
  }, [triggers, query, groupFilter, kindFilter]);

  const setGroup = (g: string) => {
    const next = new URLSearchParams(searchParams);
    if (g === 'all') next.delete('group');
    else next.set('group', g);
    setSearchParams(next, { replace: true });
  };
  const setKind = (k: KindFilter) => {
    const next = new URLSearchParams(searchParams);
    if (k === 'all') next.delete('kind');
    else next.set('kind', k);
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Триггеры</h1>
          <p className="admin-page-header__subtitle">
            Фразы, которые ведущий произносит в игре. Триггер вызывается из game_engine
            по slug; <strong>variant</strong> — один из вариантов рандомно (по seed),
            <strong> composite</strong> — собирается из сегментов с placeholder'ами.
          </p>
        </div>
        <div className="admin-page-header__actions">
          <button
            className="admin-btn admin-btn--primary"
            onClick={() => navigate('/admin/triggers/new')}
          >
            + Создать триггер
          </button>
        </div>
      </header>

      {error && <div className="admin-error-banner">{error}</div>}

      <div className="admin-card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="admin-stack">
          <input
            className="admin-input"
            placeholder="Поиск по slug, label, описанию…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="admin-row">
            <span style={{ fontSize: '0.78rem', color: '#8c8f95', marginRight: 4 }}>
              kind:
            </span>
            <FilterChip active={kindFilter === 'all'} onClick={() => setKind('all')}>
              все
            </FilterChip>
            <FilterChip active={kindFilter === 'variant'} onClick={() => setKind('variant')}>
              variant
            </FilterChip>
            <FilterChip active={kindFilter === 'composite'} onClick={() => setKind('composite')}>
              composite
            </FilterChip>
          </div>

          <div className="admin-row">
            <span style={{ fontSize: '0.78rem', color: '#8c8f95', marginRight: 4 }}>
              группа:
            </span>
            <FilterChip active={groupFilter === 'all'} onClick={() => setGroup('all')}>
              все
            </FilterChip>
            {groups.map((g) => (
              <FilterChip key={g} active={groupFilter === g} onClick={() => setGroup(g)}>
                {g}
              </FilterChip>
            ))}
          </div>
        </div>
      </div>

      {loading && <div className="admin-loading">Загрузка…</div>}

      {!loading && filtered.length === 0 && (
        <div className="admin-empty">
          <div className="admin-empty__title">Триггеры не найдены</div>
          <div>Попробуйте изменить фильтры или создать новый триггер.</div>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="admin-stack">
          {filtered.map((t) => (
            <Link
              key={t.id}
              to={`/admin/triggers/${t.id}`}
              className="admin-card"
              style={{
                margin: 0,
                textDecoration: 'none',
                color: 'inherit',
                cursor: 'pointer',
                transition: 'border-color 0.15s, background 0.15s',
                display: 'block',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                    <span
                      className={`admin-pill admin-pill--${t.kind}`}
                      style={{ flexShrink: 0 }}
                    >
                      {t.kind}
                    </span>
                    <span className="admin-pill" style={{ flexShrink: 0 }}>
                      {t.group_key}
                    </span>
                    <code
                      style={{
                        fontSize: '0.85rem',
                        color: '#8c8f95',
                        background: '#0d0e10',
                        padding: '2px 6px',
                        borderRadius: 4,
                      }}
                    >
                      {t.slug}
                    </code>
                  </div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                  {t.description && (
                    <div style={{ fontSize: '0.85rem', color: '#8c8f95' }}>
                      {t.description}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', fontSize: '0.78rem', color: '#8c8f95', flexShrink: 0 }}>
                  {t.kind === 'variant'
                    ? `${t.variants.length} вариант${suffix(t.variants.length)}`
                    : `${t.composite_templates.length} шаблон${suffix(t.composite_templates.length)}`}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`admin-pill${active ? ' admin-pill--active' : ''}`}
      style={{
        cursor: 'pointer',
        border: '1px solid transparent',
        ...(active
          ? {
              background: 'rgba(200, 30, 30, 0.18)',
              color: '#fff',
              borderColor: 'rgba(200, 30, 30, 0.45)',
            }
          : { background: 'rgba(255,255,255,0.05)' }),
      }}
    >
      {children}
    </button>
  );
}

function suffix(n: number): string {
  // Простая склонялка для русского: 1 → '', 2-4 → 'а', 5+ → 'ов'
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'а';
  return 'ов';
}
