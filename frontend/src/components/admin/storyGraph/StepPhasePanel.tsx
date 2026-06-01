/**
 * Выпадашка «Фаза шага» (payload.phase_action) для нод нарратива и развилки.
 *
 * Движок (services/story_runtime.py _apply_phase_action) при входе в шаг
 * переключает фазу игры:
 *   - enter_night    — начать новую ночь (+1 к счётчику ночей)
 *   - enter_day      — начать день
 *   - enter_finished — пометить игру завершённой
 * Пустое значение = ничего не менять (поведение как раньше).
 *
 * Сохраняет весь payload целиком (backend заменяет payload, не мёржит).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { adminStoriesApi, StoryStep } from '../../../api/adminStoriesApi';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';

interface Props {
  storyId: string;
  step: StoryStep;
  onStepUpdated: (step: StoryStep) => void;
}

const PHASE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '— не менять —' },
  { value: 'enter_night', label: 'Начать ночь (+1 к счётчику ночей)' },
  { value: 'enter_day', label: 'Начать день' },
  { value: 'enter_finished', label: 'Завершить игру' },
];

export default function StepPhasePanel({ storyId, step, onStepUpdated }: Props) {
  const initial =
    typeof step.payload?.phase_action === 'string' ? step.payload.phase_action : '';
  const [phaseAction, setPhaseAction] = useState<string>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPhaseAction(
      typeof step.payload?.phase_action === 'string' ? step.payload.phase_action : '',
    );
  }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(
    async (value: string) => {
      const payload: Record<string, unknown> = { ...(step.payload || {}) };
      if (value) payload.phase_action = value;
      else delete payload.phase_action;

      setSaving(true);
      setError(null);
      try {
        const res = await adminStoriesApi.updateStep(storyId, step.id, { payload });
        onStepUpdated(res.data);
      } catch (err) {
        const msg = parseApiError(err);
        setError(typeof msg === 'string' ? msg : 'Не удалось сохранить');
        logger.warn('admin.story.phase_action_save_failed', 'phase_action save failed', {
          error: msg,
        });
      } finally {
        setSaving(false);
      }
    },
    [storyId, step.id, step.payload, onStepUpdated],
  );

  return (
    <div className="step-edit-panel__field">
      <label>Фаза шага {saving && <span className="step-edit-panel__field-hint">сохраняю…</span>}</label>
      <select
        className="admin-select"
        value={phaseAction}
        onChange={(e) => {
          setPhaseAction(e.target.value);
          void persist(e.target.value);
        }}
      >
        {PHASE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <div className="step-edit-panel__error">{error}</div>}
      <span className="step-edit-panel__field-hint">
        Переключает фазу игры при входе в этот шаг. Оставьте «не менять», если шаг
        не начинает новую фазу.
      </span>
    </div>
  );
}
