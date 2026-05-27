/**
 * Редактор настроек сюжета (StorySettings) — этап 6.5.
 *
 * Хранит локальный draft и шлёт PUT /admin/stories/{id}/settings только при
 * нажатии "Сохранить". На вход — текущие settings (могут быть null если у
 * сюжета их ещё нет, но тогда бэкенд создаст при апдейте).
 *
 * Поля:
 * - inter_cue_pause_seconds: float (Decimal) — пауза между фразами
 *   narration. Влияет на ВСЕ narration-шаги. Pre-game можно ещё дополнительно
 *   умножить через session.settings.inter_cue_pause_seconds (override).
 * - timer_multiplier_default: float — все длительности (cues, pauses,
 *   таймеры через _wait_seconds_for) умножаются на это число.
 * - karaoke_enabled: bool — переключает narration-render на per-word
 *   подсветку (false → typewriter per-char).
 *
 * Decimal на бэке сериализуется как string ("0.00"), поэтому UI хранит
 * draft как string и парсит при сохранении (Number()). Backend парсит
 * обратно в Decimal — числа с дробью передавать без проблем.
 */
import React, { useEffect, useState } from 'react';
import { adminStoriesApi, StorySettings } from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

interface Props {
  storyId: string;
  settings: StorySettings | null;
  /**
   * Этап 6.6: флаг с Story (не из StorySettings). При сохранении
   * редактор пишет одновременно PUT /stories/{id}/settings (для
   * пауз/множителя/karaoke) и PUT /stories/{id} (для флага), если
   * они изменились.
   */
  useOnlyOwnTriggers: boolean;
  onSaved: () => Promise<void> | void;
}

export default function StorySettingsForm({
  storyId,
  settings,
  useOnlyOwnTriggers,
  onSaved,
}: Props) {
  const [pause, setPause] = useState<string>(settings?.inter_cue_pause_seconds ?? '0');
  const [multiplier, setMultiplier] = useState<string>(
    settings?.timer_multiplier_default ?? '1',
  );
  const [karaoke, setKaraoke] = useState<boolean>(settings?.karaoke_enabled ?? true);
  const [useOnlyOwn, setUseOnlyOwn] = useState<boolean>(useOnlyOwnTriggers);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [okFlash, setOkFlash] = useState(false);

  // Перезагрузить draft если props пришли новые (например после импорта).
  useEffect(() => {
    setPause(settings?.inter_cue_pause_seconds ?? '0');
    setMultiplier(settings?.timer_multiplier_default ?? '1');
    setKaraoke(settings?.karaoke_enabled ?? true);
    setUseOnlyOwn(useOnlyOwnTriggers);
  }, [
    settings?.inter_cue_pause_seconds,
    settings?.timer_multiplier_default,
    settings?.karaoke_enabled,
    useOnlyOwnTriggers,
  ]);

  const scopeDirty = useOnlyOwn !== useOnlyOwnTriggers;
  const settingsDirty =
    pause !== (settings?.inter_cue_pause_seconds ?? '0') ||
    multiplier !== (settings?.timer_multiplier_default ?? '1') ||
    karaoke !== (settings?.karaoke_enabled ?? true);
  const dirty = settingsDirty || scopeDirty;

  const pauseNum = Number(pause);
  const multNum = Number(multiplier);
  const pauseValid = !Number.isNaN(pauseNum) && pauseNum >= 0 && pauseNum <= 60;
  const multValid = !Number.isNaN(multNum) && multNum >= 0.1 && multNum <= 10;
  const formValid = pauseValid && multValid;

  const submit = async () => {
    if (!formValid) return;
    setSaving(true);
    setError('');
    try {
      // Два независимых PUT'а: settings и story-level scope flag.
      // Шлём в параллель — это разные endpoint'ы, они не бьются.
      const tasks: Promise<unknown>[] = [];
      if (settingsDirty) {
        tasks.push(
          adminStoriesApi.updateSettings(storyId, {
            inter_cue_pause_seconds: pause,
            timer_multiplier_default: multiplier,
            karaoke_enabled: karaoke,
          }),
        );
      }
      if (scopeDirty) {
        tasks.push(
          adminStoriesApi.update(storyId, { use_only_own_triggers: useOnlyOwn }),
        );
      }
      await Promise.all(tasks);
      await onSaved();
      setOkFlash(true);
      setTimeout(() => setOkFlash(false), 1500);
    } catch (err) {
      const msg = getApiErrorMessage(err) ?? 'Не удалось сохранить настройки';
      setError(msg);
      logger.warn('admin.story.settings_save_failed', msg, {
        error: parseApiError(err), storyId,
      });
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setPause(settings?.inter_cue_pause_seconds ?? '0');
    setMultiplier(settings?.timer_multiplier_default ?? '1');
    setKaraoke(settings?.karaoke_enabled ?? true);
    setUseOnlyOwn(useOnlyOwnTriggers);
  };

  return (
    <div className="admin-card">
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', marginBottom: 12,
      }}>
        <h3 style={{ margin: 0 }}>Настройки</h3>
        {okFlash && (
          <span style={{ fontSize: 11, color: '#5fa05f' }}>✓ сохранено</span>
        )}
      </div>

      {error && (
        <div className="admin-error-banner" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FieldRow
          label="Пауза между фразами (сек)"
          hint="Добавляется после каждого cue в narration-шагах. Хост может ещё домножить в lobby."
        >
          <input
            type="number"
            step="0.1"
            min={0}
            max={60}
            value={pause}
            onChange={(e) => setPause(e.target.value)}
            disabled={saving}
            style={{
              width: 90, padding: '4px 8px',
              background: '#0a0b0e', border: `1px solid ${pauseValid ? '#2a2d33' : '#7a3a3a'}`,
              borderRadius: 4, color: '#e8e9eb', fontSize: 13,
            }}
          />
          {!pauseValid && (
            <span style={{ fontSize: 11, color: '#e85a5a', marginLeft: 8 }}>
              0 ≤ x ≤ 60
            </span>
          )}
        </FieldRow>

        <FieldRow
          label="Множитель таймеров"
          hint="1.0 = норма. 2.0 = всё в два раза дольше (для медленных лобби). 0.5 = быстрый прогон для тестов."
        >
          <input
            type="number"
            step="0.1"
            min={0.1}
            max={10}
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
            disabled={saving}
            style={{
              width: 90, padding: '4px 8px',
              background: '#0a0b0e', border: `1px solid ${multValid ? '#2a2d33' : '#7a3a3a'}`,
              borderRadius: 4, color: '#e8e9eb', fontSize: 13,
            }}
          />
          {!multValid && (
            <span style={{ fontSize: 11, color: '#e85a5a', marginLeft: 8 }}>
              0.1 ≤ x ≤ 10
            </span>
          )}
        </FieldRow>

        <FieldRow
          label="Karaoke (per-word подсветка)"
          hint="Если выключено — фронт рисует typewriter (символ за символом)."
        >
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            userSelect: 'none',
          }}>
            <input
              type="checkbox"
              checked={karaoke}
              onChange={(e) => setKaraoke(e.target.checked)}
              disabled={saving}
            />
            <span style={{ fontSize: 13 }}>{karaoke ? 'Включено' : 'Выключено'}</span>
          </label>
        </FieldRow>

        <FieldRow
          label="Использовать только свои триггеры"
          hint="Если включено, в выборе триггера для cue видны только triggers этого сюжета. Иначе — свои + global namespace."
        >
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            userSelect: 'none',
          }}>
            <input
              type="checkbox"
              checked={useOnlyOwn}
              onChange={(e) => setUseOnlyOwn(e.target.checked)}
              disabled={saving}
            />
            <span style={{ fontSize: 13 }}>
              {useOnlyOwn ? 'Только свои' : 'Свои + global'}
            </span>
          </label>
        </FieldRow>
      </div>

      <div style={{
        display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12,
      }}>
        <button
          type="button"
          onClick={reset}
          disabled={!dirty || saving}
          className="admin-btn"
          style={{ opacity: !dirty ? 0.5 : 1 }}
        >
          Сбросить
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!dirty || !formValid || saving}
          className="admin-btn admin-btn--primary"
          style={{ opacity: !dirty || !formValid ? 0.5 : 1 }}
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'flex-start', gap: 16, flexWrap: 'wrap',
    }}>
      <div style={{ flex: '1 1 280px', minWidth: 200 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>{hint}</div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>{children}</div>
    </div>
  );
}
