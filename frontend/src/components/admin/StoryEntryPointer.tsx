/**
 * Editable selector точки входа сюжета (story.entry_step_id) — этап 6.5.
 *
 * Без entry_step_id сюжет нельзя запустить (StoryRuntime упадёт при попытке
 * найти первый шаг). Поэтому редактирование отдельным блоком на видном месте.
 *
 * UI: select из всех шагов сюжета или badge "не задана" если null.
 * При смене значения → PUT /admin/stories/{id} с {entry_step_id}.
 */
import React, { useEffect, useState } from 'react';
import { adminStoriesApi, StoryStep } from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

interface Props {
  storyId: string;
  entryStepId: string | null;
  steps: StoryStep[];
  onSaved: () => Promise<void> | void;
}

export default function StoryEntryPointer({
  storyId, entryStepId, steps, onSaved,
}: Props) {
  const [draft, setDraft] = useState<string>(entryStepId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(entryStepId ?? '');
  }, [entryStepId]);

  const sortedSteps = [...steps].sort((a, b) => a.slug.localeCompare(b.slug));
  const selected = steps.find((s) => s.id === draft) ?? null;
  const dirty = draft !== (entryStepId ?? '');

  const submit = async () => {
    if (!dirty || draft === '') return;
    setSaving(true);
    setError('');
    try {
      await adminStoriesApi.update(storyId, { entry_step_id: draft });
      await onSaved();
    } catch (err) {
      const msg = getApiErrorMessage(err) ?? 'Не удалось сохранить точку входа';
      setError(msg);
      logger.warn('admin.story.entry_save_failed', msg, {
        error: parseApiError(err), storyId, draft,
      });
    } finally {
      setSaving(false);
    }
  };

  const reset = () => setDraft(entryStepId ?? '');

  return (
    <div className="admin-card">
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>Точка входа</h3>

      {error && (
        <div className="admin-error-banner" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}

      {steps.length === 0 ? (
        <div className="admin-row__hint">
          Сначала добавьте хотя бы один шаг.
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            style={{
              padding: '5px 8px', background: '#0a0b0e',
              border: '1px solid #2a2d33', borderRadius: 4,
              color: '#e8e9eb', fontSize: 13, minWidth: 240,
              fontFamily: 'inherit',
            }}
          >
            <option value="">— не задана —</option>
            {sortedSteps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.slug} · {s.kind}{s.label ? ` · ${s.label}` : ''}
              </option>
            ))}
          </select>

          {dirty && (
            <>
              <button
                type="button"
                onClick={reset}
                disabled={saving}
                className="admin-btn"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={saving || draft === ''}
                className="admin-btn admin-btn--primary"
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </>
          )}

          {!dirty && entryStepId && selected && (
            <span className="admin-row__hint" style={{ marginLeft: 4 }}>
              ✓ {selected.kind}
            </span>
          )}

          {!dirty && !entryStepId && (
            <span style={{
              fontSize: 11, color: '#c8a04a',
              padding: '2px 8px', borderRadius: 4,
              border: '1px solid #5a4a1a', background: '#1f1d10',
            }}>
              Сюжет нельзя запустить без entry
            </span>
          )}
        </div>
      )}
    </div>
  );
}
