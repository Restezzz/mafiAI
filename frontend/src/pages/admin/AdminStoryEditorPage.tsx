import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  adminStoriesApi,
  StoryReadFull,
  StoryStep,
  StoryStepKind,
  StoryTransition,
} from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import StoryGraphView from '../../components/admin/StoryGraphView';
import ConditionEditor, {
  Condition,
} from '../../components/admin/ConditionEditor';
import CueListEditor from '../../components/admin/CueListEditor';
import StepPayloadEditor from '../../components/admin/StepPayloadEditor';
import StorySettingsForm from '../../components/admin/StorySettingsForm';
import StoryEntryPointer from '../../components/admin/StoryEntryPointer';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { Trigger } from '../../types/narrator';


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
const STEP_KINDS: StoryStepKind[] = [
  'narration',
  'role_action',
  'discussion',
  'voting',
  'night_resolve',
  'day_resolve',
  'branch',
  'pause',
  'end',
];

export default function AdminStoryEditorPage() {
  const { storyId } = useParams<{ storyId: string }>();
  const navigate = useNavigate();
  const [story, setStory] = useState<StoryReadFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [createStepOpen, setCreateStepOpen] = useState(false);
  const [opError, setOpError] = useState<string>('');
  const [triggers, setTriggers] = useState<Trigger[]>([]);

  // Рефактор fetch — можно передёргивать после CRUD-операций.
  const fetchStory = useCallback(async () => {
    if (!storyId) return;
    try {
      const res = await adminStoriesApi.get(storyId);
      setStory(res.data);
      setError('');
    } catch (err) {
      logger.warn('admin.story.load_failed', 'Failed to load story', {
        error: parseApiError(err),
        storyId,
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось загрузить сюжет');
    }
  }, [storyId]);

  useEffect(() => {
    if (!storyId) {
      navigate('/admin/stories');
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchStory().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [storyId, navigate, fetchStory]);

  // Подгружаем триггеры для CueListEditor с учётом scope (этап 6.6).
  // - story.use_only_own_triggers=true → только story-scoped (?story_id=X)
  // - иначе → story-scoped + global (?story_id=X&include_global=true)
  // Перезагружаются автоматически если меняется флаг (после сохранения
  // настроек fetchStory подтягивает свежий story, эффект ниже видит
  // новое значение и шлёт повторный запрос).
  const reloadTriggers = useCallback(async () => {
    if (!story) return;
    try {
      const res = await adminNarratorApi.listTriggers({
        story_id: story.id,
        include_global: !story.use_only_own_triggers,
      });
      setTriggers(res.data.triggers);
    } catch (err) {
      logger.warn('admin.story.triggers_load_failed',
        'Failed to load triggers for cue editor', { error: parseApiError(err) });
    }
  }, [story]);

  useEffect(() => {
    void reloadTriggers();
  }, [reloadTriggers]);

  // ----- CRUD callbacks (этап 6.1) ------------------------------------
  const handleCreateTransition = useCallback(
    async (params: { fromStepId: string; toStepId: string }) => {
      if (!storyId) return;
      setOpError('');
      try {
        await adminStoriesApi.createTransition(storyId, {
          from_step_id: params.fromStepId,
          to_step_id: params.toStepId,
          condition: null,
          priority: 10,
        });
        await fetchStory();
      } catch (err) {
        const msg = getApiErrorMessage(err) ?? 'Не удалось создать переход';
        setOpError(msg);
        logger.warn('admin.story.create_transition_failed', msg, {
          error: parseApiError(err),
          storyId,
          ...params,
        });
      }
    },
    [storyId, fetchStory],
  );

  const handleDeleteStep = useCallback(
    async (stepId: string) => {
      if (!storyId || !story) return;
      const target = story.steps.find((s) => s.id === stepId);
      const ok = window.confirm(
        `Удалить шаг «${target?.slug ?? stepId}»? Все входящие/исходящие ` +
          `переходы и cues будут удалены вместе с ним (cascade).`,
      );
      if (!ok) return;
      setOpError('');
      try {
        await adminStoriesApi.deleteStep(storyId, stepId);
        if (selectedStepId === stepId) setSelectedStepId(null);
        await fetchStory();
      } catch (err) {
        const msg = getApiErrorMessage(err) ?? 'Не удалось удалить шаг';
        setOpError(msg);
        logger.warn('admin.story.delete_step_failed', msg, {
          error: parseApiError(err),
          storyId,
          stepId,
        });
      }
    },
    [storyId, story, fetchStory, selectedStepId],
  );

  const handleDeleteTransition = useCallback(
    async (transitionId: string) => {
      if (!storyId) return;
      setOpError('');
      try {
        await adminStoriesApi.deleteTransition(storyId, transitionId);
        await fetchStory();
      } catch (err) {
        const msg = getApiErrorMessage(err) ?? 'Не удалось удалить переход';
        setOpError(msg);
        logger.warn('admin.story.delete_transition_failed', msg, {
          error: parseApiError(err),
          storyId,
          transitionId,
        });
      }
    },
    [storyId, fetchStory],
  );

  const handleCreateStep = useCallback(
    async (form: { slug: string; kind: StoryStepKind; label: string }) => {
      if (!storyId) return;
      setOpError('');
      try {
        await adminStoriesApi.createStep(storyId, {
          slug: form.slug,
          kind: form.kind,
          label: form.label,
        });
        setCreateStepOpen(false);
        await fetchStory();
      } catch (err) {
        const msg = getApiErrorMessage(err) ?? 'Не удалось создать шаг';
        setOpError(msg);
        logger.warn('admin.story.create_step_failed', msg, {
          error: parseApiError(err),
          storyId,
          ...form,
        });
      }
    },
    [storyId, fetchStory],
  );

  const handleSaveTransition = useCallback(
    async (transitionId: string, payload: { condition: Condition | null; priority: number }) => {
      if (!storyId) return;
      setOpError('');
      try {
        await adminStoriesApi.updateTransition(storyId, transitionId, {
          condition: payload.condition as Record<string, unknown> | null,
          unset_condition: payload.condition === null,
          priority: payload.priority,
        });
        await fetchStory();
      } catch (err) {
        const msg = getApiErrorMessage(err) ?? 'Не удалось сохранить переход';
        setOpError(msg);
        logger.warn('admin.story.update_transition_failed', msg, {
          error: parseApiError(err),
          storyId,
          transitionId,
        });
      }
    },
    [storyId, fetchStory],
  );

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

  const stepByIdMap = new Map<string, StoryStep>();
  for (const s of story.steps) {
    stepByIdMap.set(s.id, s);
  }

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
        <StorySettingsForm
          storyId={story.id}
          settings={story.settings}
          useOnlyOwnTriggers={story.use_only_own_triggers}
          onSaved={fetchStory}
        />

        {/* Entry */}
        <StoryEntryPointer
          storyId={story.id}
          entryStepId={story.entry_step_id}
          steps={story.steps}
          onSaved={fetchStory}
        />

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
                      payload (текущий)
                    </summary>
                    <pre style={{
                      margin: '4px 0 0', padding: 8, fontSize: 11,
                      background: '#1a1d22', borderRadius: 4, overflow: 'auto',
                    }}>
                      {JSON.stringify(step.payload, null, 2)}
                    </pre>
                  </details>
                )}
                <StepPayloadEditor
                  storyId={story.id}
                  step={step}
                  onSaved={fetchStory}
                />
                {step.kind === 'narration' && (
                  <CueListEditor
                    storyId={story.id}
                    stepId={step.id}
                    cues={step.cues}
                    triggers={triggers}
                    onRefetch={fetchStory}
                  />
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
                <TransitionRow
                  key={t.id}
                  transition={t}
                  fromSlug={fromStep?.slug}
                  toSlug={toStep?.slug}
                  onSave={(payload) => handleSaveTransition(t.id, payload)}
                  onDelete={() => handleDeleteTransition(t.id)}
                />
              );
            })}
          </div>
        </div>

        <div className="admin-card">
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: 8,
          }}>
            <h3 style={{ margin: 0 }}>Visual graph</h3>
            <button
              type="button"
              className="admin-btn"
              onClick={() => { setOpError(''); setCreateStepOpen(true); }}
            >
              + Новый шаг
            </button>
          </div>
          <p className="admin-row__hint" style={{ marginTop: 0 }}>
            Перетаскивайте узлы — позиция сохранится автоматически.
            Тяните от правого хэндла к левому, чтобы создать переход (priority=10, без condition).
            Выберите узел/edge и нажмите Delete, чтобы удалить (cascade на cues и связи).
          </p>
          {opError && (
            <div className="admin-error-banner" style={{ marginBottom: 8 }}>
              {opError}
            </div>
          )}
          <StoryGraphView
            story={story}
            onSelectStep={setSelectedStepId}
            onConnectEdge={handleCreateTransition}
            onDeleteStep={handleDeleteStep}
            onDeleteEdge={handleDeleteTransition}
          />
          {selectedStepId && (() => {
            const sel = stepByIdMap.get(selectedStepId);
            if (!sel) return null;
            return (
              <div style={{
                marginTop: 12, padding: 10,
                border: '1px solid #4a4d52', borderRadius: 6,
                background: '#0f1115', fontSize: 12,
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ fontFamily: 'monospace' }}>{sel.slug}</strong>
                  <span className="admin-row__hint">{sel.kind}</span>
                </div>
                {sel.label && <div style={{ marginTop: 4 }}>{sel.label}</div>}
                {Object.keys(sel.payload).length > 0 && (
                  <pre style={{
                    margin: '6px 0 0', padding: 6, fontSize: 11,
                    background: '#1a1d22', borderRadius: 4, overflow: 'auto',
                  }}>
                    {JSON.stringify(sel.payload, null, 2)}
                  </pre>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {createStepOpen && (
        <CreateStepModal
          onClose={() => setCreateStepOpen(false)}
          onSubmit={handleCreateStep}
          existingSlugs={new Set(story.steps.map((s) => s.slug))}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Строка transition с inline-editor'ом condition и priority.
// ---------------------------------------------------------------------------
function TransitionRow({
  transition,
  fromSlug,
  toSlug,
  onSave,
  onDelete,
}: {
  transition: StoryTransition;
  fromSlug?: string;
  toSlug?: string;
  onSave: (payload: { condition: Condition | null; priority: number }) => Promise<void> | void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftCondition, setDraftCondition] = useState<Condition | null>(
    transition.condition as Condition | null,
  );
  const [draftPriority, setDraftPriority] = useState(transition.priority);
  const [saving, setSaving] = useState(false);

  const beginEdit = () => {
    setDraftCondition(transition.condition as Condition | null);
    setDraftPriority(transition.priority);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftCondition(transition.condition as Condition | null);
    setDraftPriority(transition.priority);
  };

  const submit = async () => {
    setSaving(true);
    try {
      await onSave({ condition: draftCondition, priority: draftPriority });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        padding: '6px 12px',
        borderRadius: 4,
        background: transition.condition ? '#1a1d22' : '#0f1115',
        border: transition.condition ? '1px solid #4a4d52' : '1px solid #2a2d33',
        fontSize: 13,
      }}
    >
      <div style={{
        display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
      }}>
        <code>{fromSlug ?? '?'}</code>
        <span>→</span>
        <code>{toSlug ?? '?'}</code>
        <span className="admin-row__hint">priority={transition.priority}</span>
        {!transition.condition && (
          <span className="admin-row__hint" style={{ fontStyle: 'italic' }}>
            безусловный
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {!editing && (
            <>
              <button
                type="button"
                onClick={beginEdit}
                style={miniBtnStyle('#1a3a4f', '#2a5a7f', '#a4c8e8')}
              >
                ✎ редактировать
              </button>
              <button
                type="button"
                onClick={onDelete}
                style={miniBtnStyle('#3a1d22', '#5a2d33', '#e89595')}
              >
                ✕ удалить
              </button>
            </>
          )}
        </div>
      </div>

      {!editing && transition.condition && (
        <details style={{ marginTop: 4 }}>
          <summary className="admin-row__hint" style={{ cursor: 'pointer' }}>
            condition (JSON)
          </summary>
          <pre style={{
            margin: '4px 0 0', padding: 6, fontSize: 11,
            background: '#0a0b0e', borderRadius: 4, overflow: 'auto',
          }}>
            {JSON.stringify(transition.condition, null, 2)}
          </pre>
        </details>
      )}

      {editing && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11, opacity: 0.7 }}>priority</span>
            <input
              type="number"
              value={draftPriority}
              onChange={(e) => setDraftPriority(Number(e.target.value))}
              style={{
                width: 80, padding: '4px 6px', background: '#0a0b0e',
                border: '1px solid #2a2d33', borderRadius: 3,
                color: '#e8e9eb', fontSize: 12,
              }}
            />
          </div>
          <ConditionEditor value={draftCondition} onChange={setDraftCondition} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              style={miniBtnStyle('#2a2d33', '#4a4d52', '#c0c2c8')}
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              style={miniBtnStyle('#1a3a22', '#2a5a33', '#a4e8b8')}
            >
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function miniBtnStyle(bg: string, border: string, color: string): React.CSSProperties {
  return {
    fontSize: 11, padding: '3px 8px',
    background: bg, border: `1px solid ${border}`,
    color, borderRadius: 3, cursor: 'pointer',
  };
}

// ---------------------------------------------------------------------------
// Модальное окно создания шага.
// ---------------------------------------------------------------------------
function CreateStepModal({
  onClose,
  onSubmit,
  existingSlugs,
}: {
  onClose: () => void;
  onSubmit: (form: { slug: string; kind: StoryStepKind; label: string }) => void;
  existingSlugs: Set<string>;
}) {
  const [slug, setSlug] = useState('');
  const [kind, setKind] = useState<StoryStepKind>('narration');
  const [label, setLabel] = useState('');
  const slugError = !slug
    ? 'Slug обязателен'
    : !/^[a-z0-9_]{1,80}$/.test(slug)
      ? 'Slug: только [a-z0-9_], до 80 символов'
      : existingSlugs.has(slug)
        ? 'Slug уже используется в этом сюжете'
        : '';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#1a1d22', border: '1px solid #2a2d33',
          borderRadius: 8, padding: 16, minWidth: 360, maxWidth: 480,
          color: '#c0c2c8',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Новый шаг</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (slugError) return;
            onSubmit({ slug, kind, label });
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Slug</span>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              autoFocus
              placeholder="my_step_slug"
              style={{
                padding: '6px 8px', background: '#0a0b0e',
                border: '1px solid #2a2d33', borderRadius: 4,
                color: '#e8e9eb', fontFamily: 'monospace', fontSize: 13,
              }}
            />
            {slugError && slug.length > 0 && (
              <span style={{ fontSize: 11, color: '#e85a5a' }}>{slugError}</span>
            )}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as StoryStepKind)}
              style={{
                padding: '6px 8px', background: '#0a0b0e',
                border: '1px solid #2a2d33', borderRadius: 4,
                color: '#e8e9eb', fontSize: 13,
              }}
            >
              {STEP_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Label (опц.)</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Человекочитаемое название"
              style={{
                padding: '6px 8px', background: '#0a0b0e',
                border: '1px solid #2a2d33', borderRadius: 4,
                color: '#e8e9eb', fontSize: 13,
              }}
            />
          </label>
          <div style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4,
          }}>
            <button type="button" onClick={onClose} className="admin-btn">
              Отмена
            </button>
            <button
              type="submit"
              disabled={Boolean(slugError)}
              className="admin-btn admin-btn--primary"
              style={{ opacity: slugError ? 0.5 : 1 }}
            >
              Создать
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
