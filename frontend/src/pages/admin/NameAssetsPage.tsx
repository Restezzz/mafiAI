import React, { useEffect, useMemo, useRef, useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { AudioFile, Gender, NameAsset } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import AudioPlayer from '../../components/admin/AudioPlayer';
import AudioSelect from '../../components/admin/AudioSelect';

const MAX_BYTES = 10 * 1024 * 1024;

export default function NameAssetsPage() {
  const [names, setNames] = useState<NameAsset[]>([]);
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [genderFilter, setGenderFilter] = useState<'all' | Gender>('all');

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [namesRes, audioRes] = await Promise.all([
        adminNarratorApi.listNameAssets(),
        adminNarratorApi.listAudioFiles(),
      ]);
      setNames(namesRes.data.name_assets);
      setAudioFiles(audioRes.data.audio_files);
    } catch (err) {
      logger.warn('admin.names.list_failed', 'Failed to load name assets', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось загрузить имена');
    }
  };

  useEffect(() => {
    let cancelled = false;
    reload().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return names
      .filter((n) => genderFilter === 'all' || n.gender === genderFilter)
      .filter(
        (n) =>
          !q ||
          n.display_name.toLowerCase().includes(q) ||
          n.slug.toLowerCase().includes(q),
      )
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [names, query, genderFilter]);

  const handleDelete = async (n: NameAsset) => {
    if (
      !window.confirm(
        `Удалить имя «${n.display_name}»?\n\n` +
          `Связанный mp3 будет удалён, если он не используется в других местах.`,
      )
    ) {
      return;
    }
    setBusyId(n.id);
    setError('');
    try {
      await adminNarratorApi.deleteNameAsset(n.id);
      await reload();
    } catch (err) {
      logger.warn('admin.name.delete_failed', 'Failed to delete name', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить имя');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Имена игроков</h1>
          <p className="admin-page-header__subtitle">
            Произношения имён персонажей. Используются игровым движком при
            подстановке placeholder'ов <code>{'{player_name}'}</code> и т.п. Slug
            автоматически генерируется из display_name (транслит).
          </p>
        </div>
        <div className="admin-page-header__actions">
          {!creating && (
            <button
              className="admin-btn admin-btn--primary"
              onClick={() => setCreating(true)}
            >
              + Добавить имя
            </button>
          )}
        </div>
      </header>

      {error && <div className="admin-error-banner">{error}</div>}

      {creating && (
        <NameCreateForm
          onSaved={async () => {
            setCreating(false);
            await reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="admin-card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="admin-stack">
          <input
            className="admin-input"
            placeholder="Поиск по имени или slug…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="admin-row">
            <span style={{ fontSize: '0.78rem', color: '#8c8f95', marginRight: 4 }}>
              gender:
            </span>
            {(['all', 'm', 'f'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGenderFilter(g)}
                className="admin-pill"
                style={{
                  cursor: 'pointer',
                  border: '1px solid transparent',
                  ...(genderFilter === g
                    ? {
                        background: 'rgba(200, 30, 30, 0.18)',
                        color: '#fff',
                        borderColor: 'rgba(200, 30, 30, 0.45)',
                      }
                    : { background: 'rgba(255,255,255,0.05)' }),
                }}
              >
                {g === 'all' ? 'все' : g === 'm' ? 'муж' : 'жен'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <div className="admin-loading">Загрузка имён…</div>}

      {!loading && filtered.length === 0 && (
        <div className="admin-empty">
          <div className="admin-empty__title">Имена не найдены</div>
          <div>
            {query || genderFilter !== 'all'
              ? 'Попробуйте изменить фильтры.'
              : 'Добавьте первое имя.'}
          </div>
        </div>
      )}

      <div className="admin-stack">
        {filtered.map((n) =>
          editingId === n.id ? (
            <NameEditForm
              key={n.id}
              name={n}
              audioFiles={audioFiles}
              onSaved={async () => {
                setEditingId(null);
                await reload();
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <NameRow
              key={n.id}
              name={n}
              busy={busyId === n.id}
              onEdit={() => setEditingId(n.id)}
              onDelete={() => handleDelete(n)}
            />
          ),
        )}
      </div>
    </>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function NameRow({
  name,
  busy,
  onEdit,
  onDelete,
}: {
  name: NameAsset;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="admin-card"
      style={{
        margin: 0,
        padding: 14,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginBottom: 4,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: 600 }}>{name.display_name}</span>
          <span
            className="admin-pill"
            style={{
              background:
                name.gender === 'm' ? 'rgba(108, 140, 220, 0.15)' : 'rgba(220, 108, 180, 0.15)',
              color: name.gender === 'm' ? '#a4b8e4' : '#e0a4c4',
            }}
          >
            {name.gender === 'm' ? '♂ муж' : '♀ жен'}
          </span>
        </div>
        <code
          style={{
            fontSize: '0.78rem',
            color: '#8c8f95',
            background: '#0d0e10',
            padding: '2px 6px',
            borderRadius: 3,
          }}
        >
          {name.slug}
        </code>
      </div>
      <AudioPlayer url={name.audio_url} size="small" />
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className="admin-btn admin-btn--small"
          onClick={onEdit}
          disabled={busy}
        >
          Изменить
        </button>
        <button
          className="admin-btn admin-btn--small admin-btn--danger"
          onClick={onDelete}
          disabled={busy}
        >
          {busy ? '…' : 'Удалить'}
        </button>
      </div>
    </div>
  );
}

// ─── Create form ─────────────────────────────────────────────────────────────

function NameCreateForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [gender, setGender] = useState<Gender>('m');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSubmit = displayName.trim().length > 0 && !!file && !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (file && file.size > MAX_BYTES) {
      setError(`Размер mp3 превышает ${MAX_BYTES / (1024 * 1024)} MB`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await adminNarratorApi.createNameAsset({
        display_name: displayName.trim(),
        gender,
        file: file as File,
      });
      await onSaved();
    } catch (err) {
      logger.warn('admin.name.create_failed', 'Failed to create name asset', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось создать имя');
      setSaving(false);
    }
  };

  return (
    <form
      className="admin-card"
      onSubmit={handleSubmit}
      style={{
        background: '#161719',
        border: '1px solid rgba(200, 30, 30, 0.3)',
      }}
    >
      <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>Новое имя игрока</h3>

      <div className="admin-field">
        <label className="admin-field__label">Display name *</label>
        <input
          className="admin-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={saving}
          placeholder="Например, «Тёма» или «Анна Сергеевна»"
          maxLength={60}
          required
        />
        <div className="admin-field__hint">
          Slug сгенерируется автоматически (транслит). Должен быть уникальным.
        </div>
      </div>

      <div className="admin-field">
        <label className="admin-field__label">Gender *</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={`admin-btn${gender === 'm' ? ' admin-btn--primary' : ''}`}
            onClick={() => setGender('m')}
            disabled={saving}
            style={{ flex: 1 }}
          >
            ♂ Мужской
          </button>
          <button
            type="button"
            className={`admin-btn${gender === 'f' ? ' admin-btn--primary' : ''}`}
            onClick={() => setGender('f')}
            disabled={saving}
            style={{ flex: 1 }}
          >
            ♀ Женский
          </button>
        </div>
      </div>

      <div className="admin-field">
        <label className="admin-field__label">Аудио (mp3) *</label>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/mpeg,audio/mp3,.mp3"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={saving}
          style={{
            color: '#e8e8ea',
            fontSize: '0.85rem',
            background: '#0d0e10',
            border: '1px solid #3a3d42',
            borderRadius: 6,
            padding: 8,
            width: '100%',
          }}
        />
        {file && (
          <div className="admin-field__hint">
            {file.name} • {(file.size / 1024).toFixed(0)} KB
          </div>
        )}
      </div>

      {error && <div className="admin-error-banner">{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          className="admin-btn admin-btn--primary"
          disabled={!canSubmit}
        >
          {saving ? 'Создание…' : 'Создать'}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

// ─── Edit form ───────────────────────────────────────────────────────────────

function NameEditForm({
  name,
  audioFiles,
  onSaved,
  onCancel,
}: {
  name: NameAsset;
  audioFiles: AudioFile[];
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(name.display_name);
  const [gender, setGender] = useState<Gender>(name.gender);
  const [audioFileId, setAudioFileId] = useState<string>(name.audio_file_id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await adminNarratorApi.updateNameAsset(name.id, {
        display_name: displayName.trim(),
        gender,
        audio_file_id: audioFileId,
      });
      await onSaved();
    } catch (err) {
      logger.warn('admin.name.update_failed', 'Failed to update name asset', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось сохранить имя');
      setSaving(false);
    }
  };

  return (
    <form
      className="admin-card"
      onSubmit={handleSubmit}
      style={{
        background: '#161719',
        border: '1px solid rgba(200, 30, 30, 0.3)',
      }}
    >
      <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>
        Редактирование имени
      </h3>

      <div className="admin-field">
        <label className="admin-field__label">Display name</label>
        <input
          className="admin-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={saving}
          maxLength={60}
        />
        <div className="admin-field__hint">
          Текущий slug: <code>{name.slug}</code>. Изменится автоматически при смене
          имени.
        </div>
      </div>

      <div className="admin-field">
        <label className="admin-field__label">Gender</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={`admin-btn${gender === 'm' ? ' admin-btn--primary' : ''}`}
            onClick={() => setGender('m')}
            disabled={saving}
            style={{ flex: 1 }}
          >
            ♂ Мужской
          </button>
          <button
            type="button"
            className={`admin-btn${gender === 'f' ? ' admin-btn--primary' : ''}`}
            onClick={() => setGender('f')}
            disabled={saving}
            style={{ flex: 1 }}
          >
            ♀ Женский
          </button>
        </div>
      </div>

      <div className="admin-field">
        <label className="admin-field__label">Аудио (mp3)</label>
        <AudioSelect
          audioFiles={audioFiles}
          value={audioFileId}
          onChange={(id) => id && setAudioFileId(id)}
          disabled={saving}
        />
        <div className="admin-field__hint">
          Чтобы загрузить новый mp3 — сначала добавьте его в Аудиотеку, потом
          выберите здесь.
        </div>
      </div>

      {error && <div className="admin-error-banner">{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          className="admin-btn admin-btn--primary"
          disabled={saving || displayName.trim().length === 0}
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
