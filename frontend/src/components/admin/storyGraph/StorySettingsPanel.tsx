/**
 * Панель настроек сюжета — slide-in справа в graph-редакторе.
 * Этап 4.5: редактирование метаданных сюжета + StorySettings прямо из canvas.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { X, Save } from 'lucide-react';
import {
  adminStoriesApi,
  CoverCrop,
  StoryReadFull,
} from '../../../api/adminStoriesApi';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';
import { getApiErrorMessage } from '../../../utils/getApiErrorMessage';
import CoverEditor from './CoverEditor';
import './StepEditPanel.scss'; // Reuse same panel styles
import './CoverEditor.scss';

interface Props {
  story: StoryReadFull;
  onClose: () => void;
  onStoryUpdated: (story: StoryReadFull) => void;
}

export default function StorySettingsPanel({ story, onClose, onStoryUpdated }: Props) {
  // --- Metadata ---
  const [name, setName] = useState(story.name);
  const [description, setDescription] = useState(story.description ?? '');
  const [isActive, setIsActive] = useState(story.is_active);
  const [useOnlyOwn, setUseOnlyOwn] = useState(story.use_only_own_triggers);

  // --- Settings ---
  const [pause, setPause] = useState(story.settings?.inter_cue_pause_seconds ?? '0');
  const [multiplier, setMultiplier] = useState(story.settings?.timer_multiplier_default ?? '1');
  const [karaoke, setKaraoke] = useState(story.settings?.karaoke_enabled ?? true);

  // --- Cover (фича 3) ---
  const [coverImageId, setCoverImageId] = useState<string | null>(story.cover_image_id);
  const [coverUrl, setCoverUrl] = useState<string | null>(story.cover_url);
  const [coverCrop, setCoverCrop] = useState<CoverCrop | null>(story.cover_crop);
  const [coverDims, setCoverDims] = useState<{ w: number | null; h: number | null }>({
    w: null,
    h: null,
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okFlash, setOkFlash] = useState(false);

  useEffect(() => {
    setName(story.name);
    setDescription(story.description ?? '');
    setIsActive(story.is_active);
    setUseOnlyOwn(story.use_only_own_triggers);
    setPause(story.settings?.inter_cue_pause_seconds ?? '0');
    setMultiplier(story.settings?.timer_multiplier_default ?? '1');
    setKaraoke(story.settings?.karaoke_enabled ?? true);
    setCoverImageId(story.cover_image_id);
    setCoverUrl(story.cover_url);
    setCoverCrop(story.cover_crop);
    setCoverDims({ w: null, h: null });
  }, [story]);

  const pauseNum = Number(pause);
  const multNum = Number(multiplier);
  const pauseValid = !Number.isNaN(pauseNum) && pauseNum >= 0 && pauseNum <= 60;
  const multValid = !Number.isNaN(multNum) && multNum >= 0.1 && multNum <= 10;
  const nameValid = name.trim().length > 0;
  const formValid = pauseValid && multValid && nameValid;

  const handleSave = useCallback(async () => {
    if (!formValid) return;
    setSaving(true);
    setError(null);
    try {
      const tasks: Promise<unknown>[] = [];
      // Update story metadata
      const coverDirty =
        coverImageId !== story.cover_image_id ||
        JSON.stringify(coverCrop) !== JSON.stringify(story.cover_crop);
      const metaDirty =
        name !== story.name ||
        description !== (story.description ?? '') ||
        isActive !== story.is_active ||
        useOnlyOwn !== story.use_only_own_triggers;
      if (metaDirty || coverDirty) {
        tasks.push(
          adminStoriesApi.update(story.id, {
            name: name.trim(),
            description: description.trim() || undefined,
            is_active: isActive,
            use_only_own_triggers: useOnlyOwn,
            ...(coverDirty
              ? coverImageId
                ? { cover_image_id: coverImageId, cover_crop: coverCrop }
                : { unset_cover: true }
              : {}),
          }),
        );
      }
      // Update settings
      const settingsDirty =
        pause !== (story.settings?.inter_cue_pause_seconds ?? '0') ||
        multiplier !== (story.settings?.timer_multiplier_default ?? '1') ||
        karaoke !== (story.settings?.karaoke_enabled ?? true);
      if (settingsDirty) {
        tasks.push(
          adminStoriesApi.updateSettings(story.id, {
            inter_cue_pause_seconds: pause,
            timer_multiplier_default: multiplier,
            karaoke_enabled: karaoke,
          }),
        );
      }
      if (tasks.length > 0) {
        await Promise.all(tasks);
        const res = await adminStoriesApi.get(story.id);
        onStoryUpdated(res.data);
      }
      setOkFlash(true);
      setTimeout(() => setOkFlash(false), 1500);
    } catch (err) {
      setError(getApiErrorMessage(err) ?? 'Не удалось сохранить');
      logger.warn('admin.story.settings_save_failed', 'Story settings save failed', {
        error: parseApiError(err),
      });
    } finally {
      setSaving(false);
    }
  }, [story, name, description, isActive, useOnlyOwn, pause, multiplier, karaoke, coverImageId, coverCrop, formValid, onStoryUpdated]);

  return (
    <div className="step-edit-panel">
      <div className="step-edit-panel__header">
        <h3>
          Настройки сюжета
          {okFlash && <span style={{ fontSize: 11, color: '#5fa05f', marginLeft: 8 }}>✓</span>}
        </h3>
        <button type="button" className="step-edit-panel__close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="step-edit-panel__body">
        {error && <div className="step-edit-panel__error">{error}</div>}

        {/* --- Metadata --- */}
        <div className="step-edit-panel__field">
          <label>Название</label>
          <input
            className="admin-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название сюжета"
          />
        </div>

        <div className="step-edit-panel__field">
          <label>Описание</label>
          <textarea
            className="admin-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Описание (опционально)"
            rows={3}
          />
        </div>

        <div className="step-edit-panel__field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Активен (виден в лобби)
          </label>
        </div>

        <div className="step-edit-panel__divider" />

        {/* --- Cover (фича 3) --- */}
        <div className="step-edit-panel__field">
          <label>Обложка (для голосования)</label>
          <CoverEditor
            coverUrl={coverUrl}
            crop={coverCrop}
            imageWidth={coverDims.w}
            imageHeight={coverDims.h}
            onUploaded={(img) => {
              setCoverImageId(img.id);
              setCoverUrl(img.url);
              setCoverDims({ w: img.width, h: img.height });
            }}
            onCropChange={setCoverCrop}
            onRemove={() => {
              setCoverImageId(null);
              setCoverUrl(null);
              setCoverCrop(null);
            }}
          />
        </div>

        <div className="step-edit-panel__divider" />

        {/* --- Game settings --- */}
        <div className="step-edit-panel__field">
          <label>Пауза между фразами (сек)</label>
          <input
            className="admin-input"
            type="number"
            step="0.1"
            min={0}
            max={60}
            value={pause}
            onChange={(e) => setPause(e.target.value)}
            style={{ width: 90 }}
          />
          <span className="step-edit-panel__field-hint">0–60 сек, добавляется после каждого cue</span>
        </div>

        <div className="step-edit-panel__field">
          <label>Множитель таймеров</label>
          <input
            className="admin-input"
            type="number"
            step="0.1"
            min={0.1}
            max={10}
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
            style={{ width: 90 }}
          />
          <span className="step-edit-panel__field-hint">1.0 = норма, 2.0 = медленно, 0.5 = быстро</span>
        </div>

        <div className="step-edit-panel__field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={karaoke}
              onChange={(e) => setKaraoke(e.target.checked)}
            />
            Karaoke (per-word подсветка)
          </label>
          <span className="step-edit-panel__field-hint">Если выкл → typewriter (посимвольно)</span>
        </div>

        <div className="step-edit-panel__field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={useOnlyOwn}
              onChange={(e) => setUseOnlyOwn(e.target.checked)}
            />
            Только свои триггеры
          </label>
          <span className="step-edit-panel__field-hint">Если выкл → свои + global триггеры</span>
        </div>

        <button
          type="button"
          className="admin-btn admin-btn--primary"
          onClick={handleSave}
          disabled={saving || !formValid}
          style={{ marginTop: 8 }}
        >
          <Save size={14} />
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}
