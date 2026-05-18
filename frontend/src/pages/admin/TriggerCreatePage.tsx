import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { TriggerKind } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

const SLUG_REGEX = /^[a-z0-9_]+$/;

export default function TriggerCreatePage() {
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');
  const [groupKey, setGroupKey] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<TriggerKind>('variant');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const slugValid = SLUG_REGEX.test(slug) && slug.length <= 80;
  const groupValid = SLUG_REGEX.test(groupKey) && groupKey.length <= 50;
  const canSubmit = slugValid && groupValid && label.trim().length > 0 && !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await adminNarratorApi.createTrigger({
        slug: slug.trim(),
        group_key: groupKey.trim(),
        label: label.trim(),
        description: description.trim() || null,
        kind,
      });
      logger.info('admin.trigger.created', 'Trigger created via admin UI', {
        triggerId: data.id,
        slug: data.slug,
      });
      navigate(`/admin/triggers/${data.id}`, { replace: true });
    } catch (err) {
      logger.warn('admin.trigger.create_failed', 'Failed to create trigger', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось создать триггер');
      setSaving(false);
    }
  };

  return (
    <>
      <Link
        to="/admin/triggers"
        style={{
          display: 'inline-block',
          marginBottom: 16,
          color: '#8c8f95',
          textDecoration: 'none',
          fontSize: '0.85rem',
        }}
      >
        ← К списку триггеров
      </Link>

      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Новый триггер</h1>
          <p className="admin-page-header__subtitle">
            Slug и kind после создания неизменяемы. Сначала создайте триггер,
            затем добавьте к нему варианты или composite-шаблоны.
          </p>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="admin-card">
        <div className="admin-field">
          <label className="admin-field__label">Slug *</label>
          <input
            className="admin-input"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            disabled={saving}
            placeholder="например, night_intro"
            maxLength={80}
            required
          />
          <div className="admin-field__hint">
            [a-z0-9_], 1..80 символов. Используется в коде game_engine как ID
            триггера.
          </div>
          {slug && !slugValid && (
            <div className="admin-field__error">
              Только [a-z0-9_] символы, до 80 длиной.
            </div>
          )}
        </div>

        <div className="admin-field">
          <label className="admin-field__label">Group key *</label>
          <input
            className="admin-input"
            value={groupKey}
            onChange={(e) => setGroupKey(e.target.value.toLowerCase())}
            disabled={saving}
            placeholder="например, night_mafia"
            maxLength={50}
            required
          />
          <div className="admin-field__hint">
            Группа для фильтрации в UI (intro, night_mafia, day, finale и т.д.).
          </div>
          {groupKey && !groupValid && (
            <div className="admin-field__error">
              Только [a-z0-9_] символы, до 50 длиной.
            </div>
          )}
        </div>

        <div className="admin-field">
          <label className="admin-field__label">Label *</label>
          <input
            className="admin-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={saving}
            placeholder="Отображаемое название (например, «Объявление мафии»)"
            maxLength={120}
            required
          />
        </div>

        <div className="admin-field">
          <label className="admin-field__label">Описание</label>
          <textarea
            className="admin-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={saving}
            rows={3}
            placeholder="Когда и для чего используется этот триггер"
            maxLength={2000}
          />
        </div>

        <div className="admin-field">
          <label className="admin-field__label">Тип триггера *</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className={`admin-btn${kind === 'variant' ? ' admin-btn--primary' : ''}`}
              onClick={() => setKind('variant')}
              disabled={saving}
              style={{ flex: 1 }}
            >
              variant
            </button>
            <button
              type="button"
              className={`admin-btn${kind === 'composite' ? ' admin-btn--primary' : ''}`}
              onClick={() => setKind('composite')}
              disabled={saving}
              style={{ flex: 1 }}
            >
              composite
            </button>
          </div>
          <div className="admin-field__hint">
            <strong>variant</strong> — несколько вариантов фразы, один выбирается
            рандомно по seed. <strong>composite</strong> — сборка из сегментов
            (mp3 + placeholder'ы), используется для динамических фраз с именами.
          </div>
        </div>

        {error && <div className="admin-error-banner">{error}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="submit"
            className="admin-btn admin-btn--primary"
            disabled={!canSubmit}
          >
            {saving ? 'Создание…' : 'Создать триггер'}
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() => navigate('/admin/triggers')}
            disabled={saving}
          >
            Отмена
          </button>
        </div>
      </form>
    </>
  );
}
