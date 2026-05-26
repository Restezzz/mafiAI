import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  adminStoriesApi,
  StoryReadFull,
  StoryStep,
} from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';


/**
 * Редактор сюжета. В этапе 4.1 — readonly-просмотр в табличном виде:
 * - Метаданные сюжета (slug, version, is_active, описание)
 * - Список шагов с типами и cues
 * - Список переходов с conditions
 *
 * Полноценный visual editor на @xyflow/react с drag-n-drop появится в
 * этапе 4.2. Минимальные edit-возможности (rename step, edit transition
 * priority) — в этом же этапе через inline-формы.
 */
export default function AdminStoryEditorPage() {
  const { storyId } = useParams<{ storyId: string }>();
  const navigate = useNavigate();
  const [story, setStory] = useState<StoryReadFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!storyId) {
      navigate('/admin/stories');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    adminStoriesApi
      .get(storyId)
      .then((res) => {
        if (cancelled) return;
        setStory(res.data);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.warn('admin.story.load_failed', 'Failed to load story', {
          error: parseApiError(err),
          storyId,
        });
        setError(getApiErrorMessage(err) ?? 'Не удалось загрузить сюжет');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storyId, navigate]);

  if (loading) {
    return (
      <div className="admin-stack">
        <div className="admin-loading">Загружаем сюжет…</div>
      </div>
    );
  }

  if (error || !story) {
    return (
      <div className="admin-stack">
        <div className="admin-error-banner">
          {error || 'Сюжет не найден'}
        </div>
        <Link to="/admin/stories" className="admin-btn">
          ← К списку сюжетов
        </Link>
      </div>
    );
  }

  const stepBySlugMap = new Map<string, StoryStep>();
  const stepByIdMap = new Map<string, StoryStep>();
  for (const s of story.steps) {
    stepBySlugMap.set(s.slug, s);
    stepByIdMap.set(s.id, s);
  }
  const entryStep = story.entry_step_id ? stepByIdMap.get(story.entry_step_id) : null;

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">{story.name}</h1>
          <p className="admin-page-header__subtitle">
            <code>{story.slug}</code> v{story.version}
            {story.is_active && (
              <span style={{
                marginLeft: 8, fontSize: 11, padding: '2px 8px',
                borderRadius: 4, background: '#2d6a4f', color: '#fff',
              }}>
                активна
              </span>
            )}
            {story.is_obsolete && (
              <span style={{
                marginLeft: 8, fontSize: 11, padding: '2px 8px',
                borderRadius: 4, background: '#6c757d', color: '#fff',
              }}>
                архив
              </span>
            )}
          </p>
        </div>
        <div className="admin-page-header__actions">
          <Link to="/admin/stories" className="admin-btn">← К списку</Link>
        </div>
      </header>

      <div className="admin-stack">
        {story.description && (
          <div className="admin-card">
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>Описание</h3>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{story.description}</p>
          </div>
        )}

        {/* Settings */}
        {story.settings && (
          <div className="admin-card">
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>Настройки</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <tr>
                  <td style={{ padding: '4px 8px', opacity: 0.7 }}>Пауза между фразами (сек)</td>
                  <td style={{ padding: '4px 8px' }}>{story.settings.inter_cue_pause_seconds}</td>
                </tr>
                <tr>
                  <td style={{ padding: '4px 8px', opacity: 0.7 }}>Множитель таймеров</td>
                  <td style={{ padding: '4px 8px' }}>{story.settings.timer_multiplier_default}</td>
                </tr>
                <tr>
                  <td style={{ padding: '4px 8px', opacity: 0.7 }}>Karaoke</td>
                  <td style={{ padding: '4px 8px' }}>
                    {story.settings.karaoke_enabled ? 'Включено' : 'Выключено'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Entry */}
        <div className="admin-card">
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Точка входа</h3>
          {entryStep ? (
            <div>
              <code>{entryStep.slug}</code> — {entryStep.label} (
              <span className="admin-row__hint">{entryStep.kind}</span>)
            </div>
          ) : (
            <div className="admin-row__hint">
              Не задана. Сюжет нельзя запустить.
            </div>
          )}
        </div>

        {/* Steps */}
        <div className="admin-card">
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>
            Шаги ({story.steps.length})
          </h3>
          <div className="admin-stack" style={{ gap: 8 }}>
            {story.steps.map((step) => (
              <div
                key={step.id}
                style={{
                  padding: '8px 12px',
                  border: '1px solid #2a2d33',
                  borderRadius: 6,
                  background: '#0f1115',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{step.slug}</strong>
                  <span className="admin-row__hint">{step.kind}</span>
                  {step.id === story.entry_step_id && (
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 4,
                      background: '#4a90e2', color: '#fff',
                    }}>
                      entry
                    </span>
                  )}
                </div>
                <div style={{ marginTop: 4, fontSize: 14 }}>{step.label}</div>
                {Object.keys(step.payload).length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary className="admin-row__hint" style={{ cursor: 'pointer' }}>
                      payload
                    </summary>
                    <pre style={{
                      margin: '4px 0 0', padding: 8, fontSize: 11,
                      background: '#1a1d22', borderRadius: 4, overflow: 'auto',
                    }}>
                      {JSON.stringify(step.payload, null, 2)}
                    </pre>
                  </details>
                )}
                {step.cues.length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary className="admin-row__hint" style={{ cursor: 'pointer' }}>
                      Фразы ({step.cues.length})
                    </summary>
                    <ol style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 12 }}>
                      {step.cues.map((cue) => (
                        <li key={cue.id} style={{ marginTop: 2 }}>
                          {cue.trigger_slug ? (
                            <code>{cue.trigger_slug}</code>
                          ) : (
                            <em>{cue.override_text ?? '(пустая)'}</em>
                          )}
                          {cue.override_text && cue.trigger_slug && (
                            <span className="admin-row__hint"> — override: {cue.override_text}</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Transitions */}
        <div className="admin-card">
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>
            Переходы ({story.transitions.length})
          </h3>
          <div className="admin-stack" style={{ gap: 4 }}>
            {story.transitions.map((t) => {
              const fromStep = stepByIdMap.get(t.from_step_id);
              const toStep = stepByIdMap.get(t.to_step_id);
              return (
                <div
                  key={t.id}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 4,
                    background: t.condition ? '#1a1d22' : '#0f1115',
                    border: t.condition ? '1px solid #4a4d52' : '1px solid #2a2d33',
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <code>{fromStep?.slug ?? '?'}</code>
                    <span>→</span>
                    <code>{toStep?.slug ?? '?'}</code>
                    <span className="admin-row__hint">priority={t.priority}</span>
                    {!t.condition && (
                      <span className="admin-row__hint" style={{ fontStyle: 'italic' }}>
                        безусловный
                      </span>
                    )}
                  </div>
                  {t.condition && (
                    <details style={{ marginTop: 4 }}>
                      <summary className="admin-row__hint" style={{ cursor: 'pointer' }}>
                        condition
                      </summary>
                      <pre style={{
                        margin: '4px 0 0', padding: 6, fontSize: 11,
                        background: '#0a0b0e', borderRadius: 4, overflow: 'auto',
                      }}>
                        {JSON.stringify(t.condition, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="admin-card">
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Visual editor</h3>
          <p className="admin-row__hint" style={{ margin: 0 }}>
            Drag-n-drop редактор графа на @xyflow/react появится в этапе 4.2.
            Пока используйте API напрямую или дублируйте сюжет и редактируйте
            JSON-снапшот через Export → правка → Import.
          </p>
        </div>
      </div>
    </>
  );
}
