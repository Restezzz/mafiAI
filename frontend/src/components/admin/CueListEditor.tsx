/**
 * CRUD-редактор narration cues для одного шага (этап 6.3).
 *
 * Используется внутри AdminStoryEditorPage для шагов с kind='narration'.
 * Backend: services/admin_stories.py::create_cue/update_cue/delete_cue/
 * reorder_cues.
 *
 * Возможности:
 * - Список cues с trigger_slug или override_text + кнопки ↑/↓/edit/delete.
 * - ↑/↓ свапает sort_order через reorderCues bulk.
 * - Inline-редактирование cue (trigger select + override_text/duration_ms,
 *   pause_before/after_ms).
 * - Кнопка «+ Добавить фразу» открывает форму внизу. sort_order = max+1.
 *
 * Триггеры подгружаются один раз снаружи (parent кеширует) и передаются
 * в props, чтобы не делать N запросов на странице с десятками cues.
 *
 * Если в narration step есть cue без trigger_id и без override_text →
 * runtime пропустит её, но валидация на backend это разрешает (для
 * гибкости). Подсветим как warning жёлтым.
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  adminStoriesApi,
  StoryNarrationCue,
} from '../../api/adminStoriesApi';
import { Trigger, Variant } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import InlineTriggerCreator from './InlineTriggerCreator';

/** Сводка аудиозаписей у триггера: общее число вариантов и сколько с mp3. */
interface AudioSummary {
  total: number;
  withAudio: number;
  variants: Variant[];
}

function summarizeTrigger(trigger: Trigger | undefined): AudioSummary {
  if (!trigger || trigger.kind !== 'variant') {
    return { total: 0, withAudio: 0, variants: [] };
  }
  const withAudio = trigger.variants.filter((v) => Boolean(v.audio_file_id)).length;
  return {
    total: trigger.variants.length,
    withAudio,
    variants: trigger.variants,
  };
}

interface Props {
  storyId: string;
  stepId: string;
  cues: StoryNarrationCue[];
  triggers: Trigger[];
  onRefetch: () => Promise<void> | void;
  /**
   * Этап 6.6: перезаливает только список triggers (без всего
   * сюжета). Вызывается после inline-создания нового триггера,
   * чтобы dropdown в CueForm увидел свежесозданный.
   */
  onTriggersReload?: () => Promise<void> | void;
}

export default function CueListEditor({
  storyId, stepId, cues, triggers, onRefetch, onTriggersReload,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [opError, setOpError] = useState('');
  const [busy, setBusy] = useState(false);

  const sorted = [...cues].sort((a, b) => a.sort_order - b.sort_order);
  const triggerById = useMemo(() => {
    const m = new Map<string, Trigger>();
    for (const t of triggers) m.set(t.id, t);
    return m;
  }, [triggers]);

  const handleSwap = async (idxA: number, idxB: number) => {
    if (idxA < 0 || idxB < 0 || idxA >= sorted.length || idxB >= sorted.length) return;
    setBusy(true);
    setOpError('');
    try {
      const newOrder = [...sorted];
      [newOrder[idxA], newOrder[idxB]] = [newOrder[idxB], newOrder[idxA]];
      await adminStoriesApi.reorderCues(
        storyId, stepId, newOrder.map((c) => c.id),
      );
      await onRefetch();
    } catch (err) {
      const msg = getApiErrorMessage(err) ?? 'Не удалось переставить';
      setOpError(msg);
      logger.warn('admin.story.reorder_cues_failed', msg, {
        error: parseApiError(err), storyId, stepId,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (cueId: string) => {
    if (!window.confirm('Удалить фразу?')) return;
    setBusy(true);
    setOpError('');
    try {
      await adminStoriesApi.deleteCue(storyId, cueId);
      await onRefetch();
    } catch (err) {
      const msg = getApiErrorMessage(err) ?? 'Не удалось удалить';
      setOpError(msg);
      logger.warn('admin.story.delete_cue_failed', msg, {
        error: parseApiError(err), storyId, cueId,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      marginTop: 6, padding: 6, borderRadius: 4, background: '#0f1115',
      border: '1px solid #2a2d33',
    }}>
      <div style={{
        fontSize: 11, opacity: 0.7, marginBottom: 4,
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Фразы narration ({cues.length})</span>
      </div>

      {opError && (
        <div className="admin-error-banner" style={{
          fontSize: 11, padding: 4, marginBottom: 4,
        }}>
          {opError}
        </div>
      )}

      {sorted.length === 0 && !adding && (
        <div style={{ fontSize: 11, opacity: 0.5, fontStyle: 'italic', padding: 4 }}>
          (пусто)
        </div>
      )}

      {sorted.map((cue, idx) =>
        editingId === cue.id ? (
          <CueForm
            key={cue.id}
            storyId={storyId}
            triggers={triggers}
            triggerById={triggerById}
            initial={cue}
            onTriggersReload={onTriggersReload}
            onCancel={() => setEditingId(null)}
            onSubmit={async (form) => {
              setBusy(true);
              setOpError('');
              try {
                await adminStoriesApi.updateCue(storyId, cue.id, {
                  trigger_id: form.trigger_id,
                  unset_trigger: form.trigger_id === null,
                  override_text: form.override_text,
                  override_duration_ms: form.override_duration_ms,
                  pause_before_ms: form.pause_before_ms,
                  pause_after_ms: form.pause_after_ms,
                });
                setEditingId(null);
                await onRefetch();
              } catch (err) {
                const msg = getApiErrorMessage(err) ?? 'Не удалось сохранить';
                setOpError(msg);
                logger.warn('admin.story.update_cue_failed', msg, {
                  error: parseApiError(err), storyId, cueId: cue.id,
                });
              } finally {
                setBusy(false);
              }
            }}
          />
        ) : (
          <CueRow
            key={cue.id}
            cue={cue}
            idx={idx}
            isFirst={idx === 0}
            isLast={idx === sorted.length - 1}
            disabled={busy}
            audio={cue.trigger_id ? summarizeTrigger(triggerById.get(cue.trigger_id)) : null}
            onUp={() => handleSwap(idx, idx - 1)}
            onDown={() => handleSwap(idx, idx + 1)}
            onEdit={() => setEditingId(cue.id)}
            onDelete={() => handleDelete(cue.id)}
          />
        ),
      )}

      {adding ? (
        <CueForm
          storyId={storyId}
          triggers={triggers}
          triggerById={triggerById}
          initial={null}
          onTriggersReload={onTriggersReload}
          onCancel={() => setAdding(false)}
          onSubmit={async (form) => {
            setBusy(true);
            setOpError('');
            try {
              const maxSort = sorted.reduce(
                (acc, c) => Math.max(acc, c.sort_order), -1,
              );
              await adminStoriesApi.createCue(storyId, stepId, {
                sort_order: maxSort + 1,
                trigger_id: form.trigger_id,
                override_text: form.override_text,
                override_duration_ms: form.override_duration_ms,
                pause_before_ms: form.pause_before_ms,
                pause_after_ms: form.pause_after_ms,
              });
              setAdding(false);
              await onRefetch();
            } catch (err) {
              const msg = getApiErrorMessage(err) ?? 'Не удалось создать';
              setOpError(msg);
              logger.warn('admin.story.create_cue_failed', msg, {
                error: parseApiError(err), storyId, stepId,
              });
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={busy}
          style={{
            marginTop: 4, fontSize: 11, padding: '3px 8px',
            background: '#1a3a22', border: '1px solid #2a5a33',
            color: '#a4e8b8', borderRadius: 3, cursor: 'pointer',
          }}
        >
          + Добавить фразу
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Строка cue в режиме просмотра.
// ---------------------------------------------------------------------------
function CueRow({
  cue, idx, isFirst, isLast, disabled, audio,
  onUp, onDown, onEdit, onDelete,
}: {
  cue: StoryNarrationCue;
  idx: number;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  audio: AudioSummary | null;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hasTrigger = Boolean(cue.trigger_id);
  const hasText = Boolean(cue.override_text);
  const isWarning = !hasTrigger && !hasText;
  // Триггер выбран, но ни одной озвучки не привязано — отдельный warning.
  const triggerNoAudio = hasTrigger && audio !== null && audio.withAudio === 0;
  return (
    <div style={{
      padding: '4px 6px',
      marginBottom: 2,
      fontSize: 12,
      borderRadius: 3,
      border: isWarning ? '1px solid #5a4a1a' : '1px solid #2a2d33',
      background: isWarning ? '#1f1d10' : '#1a1d22',
      display: 'flex',
      gap: 6,
      alignItems: 'center',
    }}>
      <span style={{ opacity: 0.5, fontSize: 10, minWidth: 22 }}>#{idx}</span>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {hasTrigger ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <code style={{ color: '#a4c8e8' }}>
              {cue.trigger_slug ?? cue.trigger_id}
            </code>
            {audio !== null && (
              audio.withAudio > 0 ? (
                <span
                  title={`У триггера ${audio.withAudio}/${audio.total} вариантов с озвучкой`}
                  style={{
                    fontSize: 10, padding: '0 5px', borderRadius: 8,
                    background: '#1a3a22', color: '#a4e8b8',
                    border: '1px solid #2a5a33',
                  }}
                >
                  🔊 {audio.withAudio}
                </span>
              ) : (
                <span
                  title="У триггера нет вариантов с mp3 — будет только typewriter без озвучки"
                  style={{
                    fontSize: 10, padding: '0 5px', borderRadius: 8,
                    background: '#3a1a1a', color: '#e8a4a4',
                    border: '1px solid #5a2a2a',
                  }}
                >
                  🔇 нет mp3
                </span>
              )
            )}
          </span>
        ) : hasText ? (
          <span style={{
            fontStyle: 'italic', color: '#5fa05f',
            display: 'block', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            «{cue.override_text}»
          </span>
        ) : (
          <span style={{ color: '#c8a04a', fontSize: 11 }}>
            (ни trigger, ни override_text — будет пропущено)
          </span>
        )}
        {(cue.pause_before_ms > 0 || cue.pause_after_ms > 0 ||
          cue.override_duration_ms !== null) && (
          <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>
            {cue.pause_before_ms > 0 && ` ↞${cue.pause_before_ms}ms`}
            {cue.override_duration_ms !== null && ` ⌛${cue.override_duration_ms}ms`}
            {cue.pause_after_ms > 0 && ` ↠${cue.pause_after_ms}ms`}
          </span>
        )}
      </div>
      {triggerNoAudio && (
        <Link
          to={`/admin/triggers/${cue.trigger_id}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Открыть админку триггера для загрузки mp3"
          style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 3,
            background: '#3a1a1a', color: '#e8a4a4',
            border: '1px solid #5a2a2a', textDecoration: 'none',
          }}
        >
          + mp3
        </Link>
      )}
      <button
        type="button"
        onClick={onUp}
        disabled={disabled || isFirst}
        title="Вверх"
        style={cueIconBtnStyle(isFirst)}
      >↑</button>
      <button
        type="button"
        onClick={onDown}
        disabled={disabled || isLast}
        title="Вниз"
        style={cueIconBtnStyle(isLast)}
      >↓</button>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled}
        title="Редактировать"
        style={cueIconBtnStyle(false, '#a4c8e8')}
      >✎</button>
      <button
        type="button"
        onClick={onDelete}
        disabled={disabled}
        title="Удалить"
        style={cueIconBtnStyle(false, '#e89595')}
      >✕</button>
    </div>
  );
}

function cueIconBtnStyle(disabled: boolean, color = '#c0c2c8'): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '2px 6px',
    background: '#0a0b0e',
    border: '1px solid #2a2d33',
    color,
    borderRadius: 3,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    minWidth: 22,
  };
}

// ---------------------------------------------------------------------------
// Форма cue (add / edit).
// ---------------------------------------------------------------------------
interface CueFormValues {
  trigger_id: string | null;
  override_text: string | null;
  override_duration_ms: number | null;
  pause_before_ms: number;
  pause_after_ms: number;
}

function CueForm({
  storyId, triggers, triggerById, initial, onSubmit, onCancel, onTriggersReload,
}: {
  storyId: string;
  triggers: Trigger[];
  triggerById: Map<string, Trigger>;
  initial: StoryNarrationCue | null;
  onSubmit: (form: CueFormValues) => Promise<void> | void;
  onCancel: () => void;
  onTriggersReload?: () => Promise<void> | void;
}) {
  const [triggerId, setTriggerId] = useState<string | null>(
    initial?.trigger_id ?? null,
  );
  const [overrideText, setOverrideText] = useState(initial?.override_text ?? '');
  const [overrideDurationMs, setOverrideDurationMs] = useState<string>(
    initial?.override_duration_ms != null ? String(initial.override_duration_ms) : '',
  );
  const [pauseBefore, setPauseBefore] = useState(initial?.pause_before_ms ?? 0);
  const [pauseAfter, setPauseAfter] = useState(initial?.pause_after_ms ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const [creatingTrigger, setCreatingTrigger] = useState(false);

  const sortedTriggers = [...triggers].sort((a, b) => a.slug.localeCompare(b.slug));
  const selectedTrigger = triggerId ? triggerById.get(triggerId) : null;

  const inputStyle: React.CSSProperties = {
    padding: '3px 6px', background: '#0a0b0e',
    border: '1px solid #2a2d33', borderRadius: 3,
    color: '#e8e9eb', fontSize: 12,
  };
  const lblStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, opacity: 0.85,
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      await onSubmit({
        trigger_id: triggerId,
        override_text: overrideText.trim() === '' ? null : overrideText,
        override_duration_ms: overrideDurationMs.trim() === ''
          ? null
          : Number(overrideDurationMs),
        pause_before_ms: pauseBefore,
        pause_after_ms: pauseAfter,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      marginTop: 4, marginBottom: 4, padding: 8,
      background: '#0a0b0e', border: '1px solid #4a4d52',
      borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <label style={lblStyle}>
        <span style={{ minWidth: 80 }}>trigger</span>
        <select
          value={triggerId ?? ''}
          onChange={(e) => setTriggerId(e.target.value || null)}
          style={{ ...inputStyle, flex: 1 }}
        >
          <option value="">— нет (использовать override_text) —</option>
          {sortedTriggers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.story_id ? '📁' : '🌐'} {t.slug} · {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCreatingTrigger(true)}
          disabled={submitting}
          title="Создать новый story-scoped триггер inline"
          style={{
            fontSize: 11, padding: '3px 8px',
            background: '#1a3a4f', border: '1px solid #2a5a7f',
            color: '#a4c8e8', borderRadius: 3, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          + новый
        </button>
      </label>

      <TriggerAudioPanel trigger={selectedTrigger ?? null} />

      {creatingTrigger && (
        <InlineTriggerCreator
          storyId={storyId}
          onCancel={() => setCreatingTrigger(false)}
          onCreated={async (newTrigger) => {
            setCreatingTrigger(false);
            if (onTriggersReload) {
              await onTriggersReload();
            }
            // Автоматически выбираем свежесозданный триггер.
            setTriggerId(newTrigger.id);
          }}
        />
      )}

      <label style={lblStyle}>
        <span style={{ minWidth: 80 }}>override_text</span>
        <textarea
          value={overrideText}
          onChange={(e) => setOverrideText(e.target.value)}
          placeholder="Без trigger: текст, который narrator произнесёт через TTS"
          rows={2}
          style={{ ...inputStyle, flex: 1, resize: 'vertical', fontFamily: 'inherit' }}
        />
      </label>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <label style={lblStyle}>
          <span>override_duration</span>
          <input
            type="number"
            value={overrideDurationMs}
            onChange={(e) => setOverrideDurationMs(e.target.value)}
            placeholder="ms (опц.)"
            style={{ ...inputStyle, width: 90 }}
            min={0}
          />
        </label>
        <label style={lblStyle}>
          <span>pause_before</span>
          <input
            type="number"
            value={pauseBefore}
            onChange={(e) => setPauseBefore(Number(e.target.value))}
            style={{ ...inputStyle, width: 70 }}
            min={0}
          />
          <span style={{ fontSize: 10, opacity: 0.6 }}>ms</span>
        </label>
        <label style={lblStyle}>
          <span>pause_after</span>
          <input
            type="number"
            value={pauseAfter}
            onChange={(e) => setPauseAfter(Number(e.target.value))}
            style={{ ...inputStyle, width: 70 }}
            min={0}
          />
          <span style={{ fontSize: 10, opacity: 0.6 }}>ms</span>
        </label>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={{
            fontSize: 11, padding: '3px 8px',
            background: '#2a2d33', border: '1px solid #4a4d52',
            color: '#c0c2c8', borderRadius: 3, cursor: 'pointer',
          }}
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          style={{
            fontSize: 11, padding: '3px 8px',
            background: '#1a3a22', border: '1px solid #2a5a33',
            color: '#a4e8b8', borderRadius: 3, cursor: 'pointer',
          }}
        >
          {submitting ? 'Сохранение…' : initial ? 'Сохранить' : 'Создать'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Панель управления mp3 для выбранного триггера. Показывается прямо в форме
// cue, чтобы admin не лез в отдельную вкладку только чтобы понять, что
// озвучка не привязана. Превью каждого варианта + ссылка на TriggerDetailPage
// для загрузки/редактирования mp3.
// ---------------------------------------------------------------------------
function TriggerAudioPanel({ trigger }: { trigger: Trigger | null }) {
  if (trigger === null) {
    return (
      <div style={{
        marginLeft: 86, fontSize: 11, opacity: 0.55, fontStyle: 'italic',
      }}>
        Без триггера — будет проигран только <code>override_text</code> через
        typewriter (без mp3). Нужен голос — выберите триггер выше или
        {' '}
        <Link
          to="/admin/triggers/new"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#a4c8e8' }}
        >
          создайте новый ↗
        </Link>.
      </div>
    );
  }

  if (trigger.kind === 'composite') {
    return (
      <div style={{
        marginLeft: 86, fontSize: 11, color: '#c8a04a',
      }}>
        Триггер composite — собирается из сегментов с placeholder'ами (имя
        игрока и т.п.). Управление —{' '}
        <Link
          to={`/admin/triggers/${trigger.id}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#a4c8e8' }}
        >
          в админке триггера ↗
        </Link>.
      </div>
    );
  }

  const variants = trigger.variants;
  const withAudio = variants.filter((v) => Boolean(v.audio_file_id));
  const withoutAudio = variants.length - withAudio.length;

  return (
    <div style={{
      marginLeft: 86, padding: 6, borderRadius: 3,
      border: '1px solid #2a2d33', background: '#0a0b0e',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 4, gap: 8,
      }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          Озвучка триггера: <strong>{withAudio.length}</strong> с mp3
          {withoutAudio > 0 && ` · ${withoutAudio} без аудио`}
          {variants.length === 0 && ' · вариантов нет'}
        </span>
        <Link
          to={`/admin/triggers/${trigger.id}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 3,
            background: '#1a3a4f', color: '#a4c8e8',
            border: '1px solid #2a5a7f', textDecoration: 'none',
          }}
        >
          🛠 Управлять mp3 ↗
        </Link>
      </div>

      {variants.length === 0 ? (
        <div style={{ fontSize: 11, opacity: 0.5, fontStyle: 'italic' }}>
          У триггера нет ни одного варианта. Перейдите в админку триггера и
          добавьте хотя бы один (с mp3 или без — будет typewriter-fallback).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {variants.slice(0, 5).map((v) => (
            <VariantPreviewRow key={v.id} variant={v} />
          ))}
          {variants.length > 5 && (
            <div style={{ fontSize: 10, opacity: 0.5 }}>
              … и ещё {variants.length - 5} вариант(ов) — см. админку триггера
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VariantPreviewRow({ variant }: { variant: Variant }) {
  const hasAudio = Boolean(variant.audio_url);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 11, padding: '2px 4px',
      borderRadius: 2, background: '#1a1d22',
    }}>
      <span style={{
        fontSize: 10, minWidth: 36, textAlign: 'center',
        padding: '0 4px', borderRadius: 8,
        background: hasAudio ? '#1a3a22' : '#3a1a1a',
        color: hasAudio ? '#a4e8b8' : '#e8a4a4',
        border: hasAudio ? '1px solid #2a5a33' : '1px solid #5a2a2a',
      }}>
        {hasAudio ? '🔊 mp3' : '🔇'}
      </span>
      <span style={{
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', opacity: 0.85,
      }}>
        {variant.text || <em style={{ opacity: 0.5 }}>(без текста)</em>}
      </span>
      {variant.duration_ms != null && (
        <span style={{ fontSize: 10, opacity: 0.5 }}>
          {(variant.duration_ms / 1000).toFixed(1)}s
        </span>
      )}
      {hasAudio && variant.audio_url && (
        <audio
          src={variant.audio_url}
          controls
          preload="none"
          style={{ height: 22, maxWidth: 160 }}
        />
      )}
    </div>
  );
}
