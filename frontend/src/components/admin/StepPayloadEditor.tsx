/**
 * Type-aware редактор step.payload (этап 6.4).
 *
 * Каждый kind использует свой набор полей в payload (см.
 * services/story_runtime.py):
 *
 * - role_action: role_slug, action_type, timer_setting, skip_if_dead,
 *   exclude_self_target.
 * - discussion: timer_setting (default 'discussion_timer_seconds').
 * - voting: timer_setting (default 'voting_timer_seconds').
 * - narration / branch / end / night_resolve / day_resolve: kind-специфичных
 *   полей нет, но phase_action универсальный (см. ниже).
 *
 * Универсально для любого kind:
 * - phase_action ∈ {enter_night, enter_day, enter_finished} — `_apply_phase_action`
 *   создаст новую GamePhase ПЕРЕД handler'ом.
 *
 * Подход: рендерим известные поля как контролы, всё остальное (для backward
 * compat и кастомных payload-ключей) показываем raw JSON-textarea. При
 * сохранении мерджим: known fields поверх raw JSON. Это даёт хосту escape-
 * hatch не теряя UX для типичных случаев.
 */
import React, { useState, useMemo } from 'react';
import { adminStoriesApi, StoryStep, StoryStepKind } from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

const PHASE_ACTIONS = ['', 'enter_night', 'enter_day', 'enter_finished'] as const;

interface Props {
  storyId: string;
  step: StoryStep;
  onSaved: () => Promise<void> | void;
}

export default function StepPayloadEditor({ storyId, step, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          marginTop: 4, fontSize: 11, padding: '3px 8px',
          background: '#1a3a4f', border: '1px solid #2a5a7f',
          color: '#a4c8e8', borderRadius: 3, cursor: 'pointer',
        }}
      >
        ✎ редактировать payload
      </button>
    );
  }
  return (
    <PayloadForm
      storyId={storyId}
      step={step}
      onClose={() => setEditing(false)}
      onSaved={onSaved}
    />
  );
}

// ---------------------------------------------------------------------------
// Форма редактирования payload.
// ---------------------------------------------------------------------------
function PayloadForm({
  storyId, step, onClose, onSaved,
}: {
  storyId: string;
  step: StoryStep;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  // known-поля как первоклассные контролы.
  const initial = useMemo(() => parseInitial(step.kind, step.payload), [step]);
  const [phaseAction, setPhaseAction] = useState<string>(initial.phase_action);
  const [roleSlug, setRoleSlug] = useState<string>(initial.role_slug);
  const [actionType, setActionType] = useState<string>(initial.action_type);
  const [timerSetting, setTimerSetting] = useState<string>(initial.timer_setting);
  const [skipIfDead, setSkipIfDead] = useState<boolean>(initial.skip_if_dead);
  const [excludeSelf, setExcludeSelf] = useState<boolean>(initial.exclude_self_target);

  // raw JSON для extra полей. Парсим существующий payload минус known.
  const [rawJson, setRawJson] = useState<string>(() => {
    const extra = pickExtra(step.kind, step.payload);
    return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '';
  });
  const [rawError, setRawError] = useState('');

  const [saving, setSaving] = useState(false);
  const [opError, setOpError] = useState('');

  const submit = async () => {
    setOpError('');
    setRawError('');
    let extra: Record<string, unknown> = {};
    if (rawJson.trim()) {
      try {
        extra = JSON.parse(rawJson);
        if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
          throw new Error('JSON должен быть объектом');
        }
      } catch (err) {
        setRawError(`Невалидный JSON: ${(err as Error).message}`);
        return;
      }
    }
    const merged = buildPayload(step.kind, {
      phase_action: phaseAction,
      role_slug: roleSlug,
      action_type: actionType,
      timer_setting: timerSetting,
      skip_if_dead: skipIfDead,
      exclude_self_target: excludeSelf,
    }, extra);

    setSaving(true);
    try {
      await adminStoriesApi.updateStep(storyId, step.id, { payload: merged });
      await onSaved();
      onClose();
    } catch (err) {
      const msg = getApiErrorMessage(err) ?? 'Не удалось сохранить payload';
      setOpError(msg);
      logger.warn('admin.story.update_step_payload_failed', msg, {
        error: parseApiError(err), storyId, stepId: step.id,
      });
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: '3px 6px', background: '#0a0b0e',
    border: '1px solid #2a2d33', borderRadius: 3,
    color: '#e8e9eb', fontSize: 12,
  };
  const lblStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, opacity: 0.85,
  };

  return (
    <div style={{
      marginTop: 4, padding: 8,
      background: '#0a0b0e', border: '1px solid #4a4d52', borderRadius: 4,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {opError && <div className="admin-error-banner" style={{ fontSize: 11 }}>{opError}</div>}

      {/* phase_action универсально */}
      <label style={lblStyle}>
        <span style={{ minWidth: 100 }}>phase_action</span>
        <select
          value={phaseAction}
          onChange={(e) => setPhaseAction(e.target.value)}
          style={{ ...inputStyle, minWidth: 160 }}
        >
          {PHASE_ACTIONS.map((p) => (
            <option key={p} value={p}>{p === '' ? '— нет —' : p}</option>
          ))}
        </select>
        <span style={{ fontSize: 10, opacity: 0.6 }}>
          создаёт GamePhase до handler'а
        </span>
      </label>

      {step.kind === 'role_action' && (
        <>
          <label style={lblStyle}>
            <span style={{ minWidth: 100 }}>role_slug *</span>
            <input
              type="text"
              value={roleSlug}
              onChange={(e) => setRoleSlug(e.target.value)}
              placeholder="mafia / sheriff / doctor / lover / ..."
              style={{ ...inputStyle, flex: 1 }}
            />
          </label>
          <label style={lblStyle}>
            <span style={{ minWidth: 100 }}>action_type</span>
            <input
              type="text"
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              placeholder="kill / check / heal / love (по умолч. — auto)"
              style={{ ...inputStyle, flex: 1 }}
            />
          </label>
          <label style={lblStyle}>
            <span style={{ minWidth: 100 }}>timer_setting</span>
            <input
              type="text"
              value={timerSetting}
              onChange={(e) => setTimerSetting(e.target.value)}
              placeholder="night_action_timer_seconds"
              style={{ ...inputStyle, flex: 1 }}
            />
          </label>
          <label style={lblStyle}>
            <input
              type="checkbox"
              checked={skipIfDead}
              onChange={(e) => setSkipIfDead(e.target.checked)}
            />
            <span>skip_if_dead</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>
              пропустить если все носители роли мертвы
            </span>
          </label>
          <label style={lblStyle}>
            <input
              type="checkbox"
              checked={excludeSelf}
              onChange={(e) => setExcludeSelf(e.target.checked)}
            />
            <span>exclude_self_target</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>
              нельзя выбрать себя как цель
            </span>
          </label>
        </>
      )}

      {(step.kind === 'discussion' || step.kind === 'voting') && (
        <label style={lblStyle}>
          <span style={{ minWidth: 100 }}>timer_setting</span>
          <input
            type="text"
            value={timerSetting}
            onChange={(e) => setTimerSetting(e.target.value)}
            placeholder={
              step.kind === 'discussion'
                ? 'discussion_timer_seconds'
                : 'voting_timer_seconds'
            }
            style={{ ...inputStyle, flex: 1 }}
          />
        </label>
      )}

      <details>
        <summary style={{
          cursor: 'pointer', fontSize: 11, opacity: 0.7, marginTop: 4,
        }}>
          Дополнительные поля (raw JSON)
        </summary>
        <textarea
          value={rawJson}
          onChange={(e) => setRawJson(e.target.value)}
          rows={4}
          placeholder='{"custom_field": "value"}'
          style={{
            ...inputStyle, width: '100%', marginTop: 4,
            fontFamily: 'monospace', resize: 'vertical',
          }}
        />
        {rawError && (
          <div style={{ color: '#e85a5a', fontSize: 11, marginTop: 4 }}>
            {rawError}
          </div>
        )}
      </details>

      <div style={{
        display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4,
      }}>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
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
          disabled={saving}
          style={{
            fontSize: 11, padding: '3px 8px',
            background: '#1a3a22', border: '1px solid #2a5a33',
            color: '#a4e8b8', borderRadius: 3, cursor: 'pointer',
          }}
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers: разделение payload на известные поля и extra.
// ---------------------------------------------------------------------------
function knownFields(kind: StoryStepKind): Set<string> {
  // phase_action всегда known.
  const base = new Set<string>(['phase_action']);
  switch (kind) {
    case 'role_action':
      ['role_slug', 'action_type', 'timer_setting',
        'skip_if_dead', 'exclude_self_target'].forEach((k) => base.add(k));
      break;
    case 'discussion':
    case 'voting':
      base.add('timer_setting');
      break;
    default:
      break;
  }
  return base;
}

function pickExtra(
  kind: StoryStepKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const known = knownFields(kind);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!known.has(k)) out[k] = v;
  }
  return out;
}

interface InitialFields {
  phase_action: string;
  role_slug: string;
  action_type: string;
  timer_setting: string;
  skip_if_dead: boolean;
  exclude_self_target: boolean;
}

function parseInitial(
  _kind: StoryStepKind,
  payload: Record<string, unknown>,
): InitialFields {
  return {
    phase_action: typeof payload.phase_action === 'string' ? payload.phase_action : '',
    role_slug: typeof payload.role_slug === 'string' ? payload.role_slug : '',
    action_type: typeof payload.action_type === 'string' ? payload.action_type : '',
    timer_setting: typeof payload.timer_setting === 'string' ? payload.timer_setting : '',
    skip_if_dead: payload.skip_if_dead !== false, // default true
    exclude_self_target: payload.exclude_self_target !== false, // default true
  };
}

function buildPayload(
  kind: StoryStepKind,
  fields: InitialFields,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra };

  // phase_action — пустая строка → не пишем.
  if (fields.phase_action) out.phase_action = fields.phase_action;

  if (kind === 'role_action') {
    if (fields.role_slug) out.role_slug = fields.role_slug;
    if (fields.action_type) out.action_type = fields.action_type;
    if (fields.timer_setting) out.timer_setting = fields.timer_setting;
    // skip_if_dead default true → пишем только если false
    if (!fields.skip_if_dead) out.skip_if_dead = false;
    // exclude_self_target default true → пишем только если false
    if (!fields.exclude_self_target) out.exclude_self_target = false;
  } else if (kind === 'discussion' || kind === 'voting') {
    if (fields.timer_setting) out.timer_setting = fields.timer_setting;
  }
  return out;
}
