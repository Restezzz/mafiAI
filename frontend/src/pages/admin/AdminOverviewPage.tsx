import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import { AudioFile, NameAsset, PlaceholderInfo, Trigger } from '../../types/narrator';

interface Stats {
  triggers: number;
  variantTriggers: number;
  compositeTriggers: number;
  variantsWithAudio: number;
  variantsTextOnly: number;
  compositeTemplates: number;
  audioFiles: number;
  nameAssets: number;
  placeholders: number;
  groupCounts: Record<string, number>;
}

function calcStats(
  triggers: Trigger[],
  audios: AudioFile[],
  names: NameAsset[],
  placeholders: PlaceholderInfo[],
): Stats {
  const groupCounts: Record<string, number> = {};
  let variantTriggers = 0;
  let compositeTriggers = 0;
  let variantsWithAudio = 0;
  let variantsTextOnly = 0;
  let compositeTemplates = 0;
  for (const t of triggers) {
    groupCounts[t.group_key] = (groupCounts[t.group_key] ?? 0) + 1;
    if (t.kind === 'variant') {
      variantTriggers++;
      for (const v of t.variants) {
        if (v.audio_file_id) variantsWithAudio++;
        else variantsTextOnly++;
      }
    } else {
      compositeTriggers++;
      compositeTemplates += t.composite_templates.length;
    }
  }
  return {
    triggers: triggers.length,
    variantTriggers,
    compositeTriggers,
    variantsWithAudio,
    variantsTextOnly,
    compositeTemplates,
    audioFiles: audios.length,
    nameAssets: names.length,
    placeholders: placeholders.length,
    groupCounts,
  };
}

export default function AdminOverviewPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      adminNarratorApi.listTriggers(),
      adminNarratorApi.listAudioFiles(),
      adminNarratorApi.listNameAssets(),
      adminNarratorApi.listPlaceholders(),
    ])
      .then(([t, a, n, p]) => {
        if (cancelled) return;
        setStats(
          calcStats(t.data.triggers, a.data.audio_files, n.data.name_assets, p.data.placeholders),
        );
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.warn('admin.overview.load_failed', 'Failed to load admin overview', {
          error: parseApiError(err),
        });
        setError(getApiErrorMessage(err) ?? 'Не удалось загрузить статистику');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Обзор narrator-системы</h1>
          <p className="admin-page-header__subtitle">
            Сводка по триггерам, аудиофайлам и именам игроков, которые используются для
            фраз ведущего.
          </p>
        </div>
      </header>

      {loading && <div className="admin-loading">Загрузка…</div>}
      {error && <div className="admin-error-banner">{error}</div>}

      {stats && (
        <div className="admin-stack">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 16,
            }}
          >
            <StatCard label="Триггеров" value={stats.triggers} accent="#c81e1e" />
            <StatCard label="Аудио-файлов" value={stats.audioFiles} accent="#d8a96a" />
            <StatCard label="Имён игроков" value={stats.nameAssets} accent="#a4b8e4" />
            <StatCard label="Placeholder'ов" value={stats.placeholders} accent="#d4a046" />
          </div>

          <div className="admin-card">
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>Типы триггеров</h3>
            <div className="admin-row">
              <span className="admin-pill admin-pill--variant">
                variant: {stats.variantTriggers}
              </span>
              <span className="admin-pill admin-pill--composite">
                composite: {stats.compositeTriggers}
              </span>
              <span className="admin-pill">
                вариантов с mp3: {stats.variantsWithAudio}
              </span>
              <span className="admin-pill">
                text-only: {stats.variantsTextOnly}
              </span>
              <span className="admin-pill">
                composite templates: {stats.compositeTemplates}
              </span>
            </div>
          </div>

          <div className="admin-card">
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>По группам</h3>
            <div className="admin-row">
              {Object.entries(stats.groupCounts)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([group, count]) => (
                  <Link
                    key={group}
                    to={`/admin/triggers?group=${group}`}
                    className="admin-pill"
                    style={{ textDecoration: 'none' }}
                  >
                    {group}: {count}
                  </Link>
                ))}
            </div>
          </div>

          <div className="admin-card">
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>Быстрые действия</h3>
            <div className="admin-row">
              <Link to="/admin/triggers" className="admin-btn">
                Управление триггерами
              </Link>
              <Link to="/admin/audio" className="admin-btn">
                Загрузить mp3
              </Link>
              <Link to="/admin/names" className="admin-btn">
                Добавить имя
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div
      className="admin-card"
      style={{
        margin: 0,
        borderLeft: `3px solid ${accent}`,
        padding: '14px 18px',
      }}
    >
      <div style={{ fontSize: '0.78rem', color: '#8c8f95', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.8rem', fontWeight: 600 }}>{value}</div>
    </div>
  );
}
