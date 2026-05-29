/**
 * Панель редактирования перехода (edge) — slide-in справа.
 * Открывается по double-click на edge в graph-редакторе.
 *
 * Позволяет:
 * - Видеть from → to (slug/label шагов)
 * - Редактировать priority
 * - Редактировать condition (JSON)
 * - Очистить condition
 */
import React, { useCallback, useEffect, useState } from 'react';
import { X, Save, AlertTriangle } from 'lucide-react';
import {
  adminStoriesApi,
  StoryTransition,
  StoryStep,
} from '../../../api/adminStoriesApi';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';
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
  const [conditionJson, setConditionJson] = useState(
    transition.condition ? JSON.stringify(transition.condition, null, 2) : '',
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPriority(String(transition.priority));
    setConditionJson(
      transition.condition ? JSON.stringify(transition.condition, null, 2) : '',
    );
  }, [transition]);

  const fromStep = steps.find((s) => s.id === transition.from_step_id);
  const toStep = steps.find((s) => s.id === transition.to_step_id);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setJsonError(null);

    let condition: Record<string, unknown> | null = null;
    let unsetCondition = false;

    if (conditionJson.trim()) {
      try {
        condition = JSON.parse(conditionJson.trim());
      } catch {
        setJsonError('Невалидный JSON');
        setSaving(false);
        return;
      }
    } else {
      unsetCondition = true;
    }

    try {
      const res = await adminStoriesApi.updateTransition(storyId, transition.id, {
        priority: parseInt(priority, 10) || 0,
        ...(unsetCondition ? { unset_condition: true } : { condition }),
      });
      onTransitionUpdated(res.data);
    } catch (err) {
      setError('Не удалось сохранить');
      logger.warn('admin.story.transition_update_failed', 'Transition update failed', {
        error: parseApiError(err),
      });
    } finally {
      setSaving(false);
    }
  }, [storyId, transition.id, priority, conditionJson, onTransitionUpdated]);

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
            Выше число → проверяется первым
          </span>
        </div>

        <div className="step-edit-panel__field">
          <label>Condition (JSON)</label>
          <textarea
            className="admin-textarea step-edit-panel__json-editor"
            value={conditionJson}
            onChange={(e) => {
              setConditionJson(e.target.value);
              setJsonError(null);
            }}
            placeholder='{"op": "alive_count_le", "args": {"count": 3}}'
            rows={6}
          />
          {jsonError && (
            <div className="step-edit-panel__cue-warn">
              <AlertTriangle size={11} />
              <span>{jsonError}</span>
            </div>
          )}
          <span className="step-edit-panel__field-hint">
            Оставьте пустым для безусловного перехода
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
