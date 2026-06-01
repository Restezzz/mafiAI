/**
 * Панель настроек ноды «Ход роли» (role_action).
 *
 * Движок (services/story_runtime.py _handle_role_action) читает из step.payload:
 *   - role_slug (обязательно) — какая роль ходит; без него ход молча пропускается
 *   - action_type (опц.) — для стандартных ролей определяется автоматически
 *   - timer_setting (опц.) — ключ таймера в настройках катки
 *   - skip_if_dead (bool, по умолчанию true)
 *   - exclude_self_target (bool, по умолчанию true)
 *
 * Сохраняет весь payload целиком (backend заменяет payload, не мёржит).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  adminStoriesApi,
  StoryStep,
  RoleCatalogItem,
} from '../../../api/adminStoriesApi';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';

interface Props {
  storyId: string;
  step: StoryStep;
  onStepUpdated: (step: StoryStep) => void;
}

interface FormState {
  roleSlug: string;
  actionType: string;
  timerSetting: string;
  skipIfDead: boolean;
  excludeSelf: boolean;
}

function formFromPayload(payload: Record<string, unknown>): FormState {
  return {
    roleSlug: typeof payload.role_slug === 'string' ? payload.role_slug : '',
    actionType: typeof payload.action_type === 'string' ? payload.action_type : '',
    timerSetting: typeof payload.timer_setting === 'string' ? payload.timer_setting : '',
    skipIfDead: payload.skip_if_dead !== false,
    excludeSelf: payload.exclude_self_target !== false,
  };
}

export default function RoleActionPanel({ storyId, step, onStepUpdated }: Props) {
  const [roles, setRoles] = useState<RoleCatalogItem[]>([]);
  const [form, setForm] = useState<FormState>(() => formFromPayload(step.payload || {}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminStoriesApi
      .listRoles()
      .then((res) => setRoles(res.data.roles))
      .catch((err) =>
        logger.warn('admin.story.roles_list_failed', 'roles list failed', {
          error: parseApiError(err),
        }),
      );
  }, []);

  useEffect(() => {
    setForm(formFromPayload(step.payload || {}));
  }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(
    async (next: FormState) => {
      const payload: Record<string, unknown> = { ...(step.payload || {}) };
      if (next.roleSlug) payload.role_slug = next.roleSlug;
      else delete payload.role_slug;
      if (next.actionType) payload.action_type = next.actionType;
      else delete payload.action_type;
      if (next.timerSetting) payload.timer_setting = next.timerSetting;
      else delete payload.timer_setting;
      payload.skip_if_dead = next.skipIfDead;
      payload.exclude_self_target = next.excludeSelf;

      setSaving(true);
      setError(null);
      try {
        const res = await adminStoriesApi.updateStep(storyId, step.id, { payload });
        onStepUpdated(res.data);
      } catch (err) {
        const msg = parseApiError(err);
        setError(typeof msg === 'string' ? msg : 'Не удалось сохранить');
        logger.warn('admin.story.role_action_save_failed', 'role_action save failed', {
          error: msg,
        });
      } finally {
        setSaving(false);
      }
    },
    [storyId, step.id, step.payload, onStepUpdated],
  );

  const update = useCallback(
    (patch: Partial<FormState>, commit: boolean) => {
      setForm((prev) => {
        const next = { ...prev, ...patch };
        if (commit) void persist(next);
        return next;
      });
    },
    [persist],
  );

  const knownRole = roles.find((r) => r.slug === form.roleSlug);

  return (
    <div className="step-edit-panel__section">
      <div className="step-edit-panel__section-header">
        <span>Настройки хода роли</span>
        {saving && <span className="step-edit-panel__field-hint">сохраняю…</span>}
      </div>

      {error && <div className="step-edit-panel__error">{error}</div>}

      <div className="step-edit-panel__field">
        <label>Какая роль ходит</label>
        <select
          className="admin-select"
          value={form.roleSlug}
          onChange={(e) => update({ roleSlug: e.target.value }, true)}
        >
          <option value="">— выберите роль —</option>
          {roles.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.name} ({r.slug})
            </option>
          ))}
          {/* Роль из payload, которой нет в каталоге — показываем как есть. */}
          {form.roleSlug && !knownRole && (
            <option value={form.roleSlug}>{form.roleSlug}</option>
          )}
        </select>
        {!form.roleSlug && (
          <div className="step-edit-panel__cue-warn">
            <AlertTriangle size={11} />
            <span>Без выбранной роли ход в игре будет пропущен.</span>
          </div>
        )}
      </div>

      <div className="step-edit-panel__field">
        <label>Тип действия (необязательно)</label>
        <input
          className="admin-input"
          value={form.actionType}
          onChange={(e) => update({ actionType: e.target.value }, false)}
          onBlur={() => persist(form)}
          placeholder="напр. kill / check / heal"
        />
        <span className="step-edit-panel__field-hint">
          Для стандартных ролей (мафия, шериф, дон, доктор, любовница, маньяк)
          определяется автоматически. Заполняйте только для своих ролей.
        </span>
      </div>

      <div className="step-edit-panel__field">
        <label>Ключ таймера (необязательно)</label>
        <input
          className="admin-input"
          value={form.timerSetting}
          onChange={(e) => update({ timerSetting: e.target.value }, false)}
          onBlur={() => persist(form)}
          placeholder="night_action_timer_seconds"
        />
        <span className="step-edit-panel__field-hint">
          Какой таймер из настроек катки использовать. Пусто = ночной таймер по
          умолчанию.
        </span>
      </div>

      <div className="step-edit-panel__field">
        <label className="step-edit-panel__checkbox-row">
          <input
            type="checkbox"
            checked={form.skipIfDead}
            onChange={(e) => update({ skipIfDead: e.target.checked }, true)}
          />
          <span>Пропустить ход, если носитель роли мёртв</span>
        </label>
      </div>

      <div className="step-edit-panel__field">
        <label className="step-edit-panel__checkbox-row">
          <input
            type="checkbox"
            checked={form.excludeSelf}
            onChange={(e) => update({ excludeSelf: e.target.checked }, true)}
          />
          <span>Нельзя выбрать самого себя целью</span>
        </label>
      </div>
    </div>
  );
}
