/**
 * Панель редактирования перехода (edge) — slide-in справа.
 * Открывается по double-click на edge в graph-редакторе.
 *
 * Позволяет:
 * - Видеть from → to (slug/label шагов)
 * - Редактировать priority
 * - Редактировать condition через структурный конструктор (выбор из списка),
 *   без ручного ввода JSON
 * - Очистить condition (безусловный переход)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { X, Save } from 'lucide-react';
import {
  adminStoriesApi,
  StoryTransition,
  StoryStep,
} from '../../../api/adminStoriesApi';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';
import ConditionEditor, { Condition } from '../ConditionEditor';
import { describeCondition } from './conditionUtils';
import './StepEditPanel.scss'; // Reuse same panel styles

interface Props {
  storyId: string;
  transition: StoryTransition;
  steps: StoryStep[];
  onClose: () => void;
  onTransitionUpdated: (t: StoryTransition) => void;
}

export default function EdgeEditPanel({
  storyId,
  transition,
  steps,
  onClose,
  onTransitionUpdated,
}: Props) {
  const [priority, setPriority] = useState(String(transition.priority));
  const [condition, setCondition] = useState<Condition | null>(
    (transition.condition as Condition | null) ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPriority(String(transition.priority));
    setCondition((transition.condition as Condition | null) ?? null);
  }, [transition]);

  const fromStep = steps.find((s) => s.id === transition.from_step_id);
  const toStep = steps.find((s) => s.id === transition.to_step_id);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);

    try {
      const res = await adminStoriesApi.updateTransition(storyId, transition.id, {
        priority: parseInt(priority, 10) || 0,
        ...(condition
          ? { condition: condition as unknown as Record<string, unknown> }
          : { unset_condition: true }),
      });
      onTransitionUpdated(res.data);
    } catch (err) {
      const msg = parseApiError(err);
      setError(typeof msg === 'string' ? msg : 'Не удалось сохранить');
      logger.warn('admin.story.transition_update_failed', 'Transition update failed', {
        error: msg,
      });
    } finally {
      setSaving(false);
    }
  }, [storyId, transition.id, priority, condition, onTransitionUpdated]);

  return (
    <div className="step-edit-panel">
      <div className="step-edit-panel__header">
        <h3>Редактирование перехода</h3>
        <button type="button" className="step-edit-panel__close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="step-edit-panel__body">
        {error && <div className="step-edit-panel__error">{error}</div>}

        <div className="step-edit-panel__field">
          <label>Откуда</label>
          <div className="step-edit-panel__kind-badge">
            {fromStep ? `${fromStep.slug} (${fromStep.kind})` : transition.from_step_id}
          </div>
        </div>

        <div className="step-edit-panel__field">
          <label>Куда</label>
          <div className="step-edit-panel__kind-badge">
            {toStep ? `${toStep.slug} (${toStep.kind})` : transition.to_step_id}
          </div>
        </div>

        <div className="step-edit-panel__divider" />

        <div className="step-edit-panel__field">
          <label>Приоритет</label>
          <input
            className="admin-input"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            min={0}
            placeholder="0"
          />
          <span className="step-edit-panel__field-hint">
            Если из шага выходит несколько стрелок — выше число проверяется первым
          </span>
        </div>

        <div className="step-edit-panel__field">
          <label>Условие перехода</label>
          <ConditionEditor value={condition} onChange={setCondition} />
          <span className="step-edit-panel__field-hint">
            {condition
              ? `Переход сработает, если: ${describeCondition(
                  condition as unknown as Record<string, unknown>,
                )}`
              : 'Без условия — безусловный переход (fallback). Выберите тип, чтобы добавить условие.'}
          </span>
        </div>

        <button
          type="button"
          className="admin-btn admin-btn--primary"
          onClick={handleSave}
          disabled={saving}
          style={{ marginTop: 8 }}
        >
          <Save size={14} />
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}
