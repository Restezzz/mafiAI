/**
 * Панель редактирования шага (slide-in справа поверх палитры).
 * Открывается по double-click на ноду в graph-редакторе.
 *
 * Позволяет:
 * - Редактировать label и slug шага
 * - Управлять cues: режим «Триггер» (глобальный) или «Свои варианты»
 * - В режиме «Свои варианты» — inline CRUD вариантов (текст + mp3)
 * - Под капотом «Свои варианты» создаёт auto-trigger (story-scoped)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Plus,
  Trash2,
  Mic,
  AlertTriangle,
  Upload,
  Play,
  Square,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import {
  adminStoriesApi,
  StoryStep,
  StoryNarrationCue,
  StoryNarrationCueCreatePayload,
  StoryNameVariant,
  StoryReadFull,
} from '../../../api/adminStoriesApi';
import { adminNarratorApi } from '../../../api/adminNarratorApi';
import { AudioFile, Trigger, Variant } from '../../../types/narrator';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';
import { API_BASE_URL } from '../../../utils/constants';
import NamesNodePanel from './NamesNodePanel';
import RolesNodePanel from './RolesNodePanel';
import './StepEditPanel.scss';

interface Props {
  storyId: string;
  step: StoryStep;
  story: StoryReadFull | null;
  onClose: () => void;
  onStepUpdated: (step: StoryStep) => void;
  onStoryChanged: () => void;
}

/* ------------------------------------------------------------------ */
/*  Auto-trigger prefix for cues using "own variants" mode            */
/* ------------------------------------------------------------------ */
const AUTO_TRIGGER_PREFIX = 'auto_cue_';

function isAutoTrigger(trigger: Trigger): boolean {
  return trigger.slug.startsWith(AUTO_TRIGGER_PREFIX) && trigger.story_id !== null;
}

/* ------------------------------------------------------------------ */
/*  Mini audio player                                                 */
/* ------------------------------------------------------------------ */
function MiniAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  };

  const fullUrl = `${API_BASE_URL}${src}`;

  return (
    <span className="step-edit-panel__mini-player">
      <audio
        ref={audioRef}
        src={fullUrl}
        onEnded={() => setPlaying(false)}
        onError={() => setPlaying(false)}
        preload="none"
      />
      <button
        type="button"
        className="step-edit-panel__play-btn"
        onClick={toggle}
        title={playing ? 'Стоп' : 'Прослушать'}
      >
        {playing ? <Square size={10} /> : <Play size={10} />}
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Editable variant row                                              */
/* ------------------------------------------------------------------ */
function VariantRow({
  variant,
  index,
  total,
  onTextSaved,
  onUploadMp3,
  onPickExisting,
  onUnset,
  onDelete,
  onMoveUp,
  onMoveDown,
  uploading,
  audioFiles,
}: {
  variant: Variant;
  index: number;
  total: number;
  onTextSaved: (id: string, text: string) => void;
  onUploadMp3: (id: string, file: File) => void;
  onPickExisting: (variantId: string, audioFileId: string) => void;
  onUnset: (variantId: string) => void;
  onDelete: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  uploading: boolean;
  audioFiles: AudioFile[];
}) {
  const [text, setText] = useState(variant.text);

  useEffect(() => { setText(variant.text); }, [variant.text]);

  const save = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setText(variant.text);
      return;
    }
    if (trimmed !== variant.text) onTextSaved(variant.id, trimmed);
  };

  return (
    <div className="step-edit-panel__variant">
      <div className="step-edit-panel__variant-header">
        <span className="step-edit-panel__variant-label">Вариант {index}</span>
        <div className="step-edit-panel__variant-controls">
          <button
            type="button"
            className="step-edit-panel__icon-btn"
            onClick={() => onMoveUp(variant.id)}
            disabled={index === 1}
            title="Вверх"
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            className="step-edit-panel__icon-btn"
            onClick={() => onMoveDown(variant.id)}
            disabled={index === total}
            title="Вниз"
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            className="step-edit-panel__cue-delete"
            onClick={() => onDelete(variant.id)}
            title="Удалить вариант"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      <textarea
        className="step-edit-panel__variant-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        placeholder="Текст, который увидят игроки..."
        rows={2}
      />
      <div className="step-edit-panel__variant-audio">
        {variant.audio_url && <MiniAudioPlayer src={variant.audio_url} />}
        <label className="step-edit-panel__upload-label" title="Загрузить аудио">
          <Upload size={12} />
          <span>{variant.audio_file_id ? 'Заменить' : 'Загрузить'}</span>
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUploadMp3(variant.id, f);
            }}
            disabled={uploading}
            style={{ display: 'none' }}
          />
        </label>
        {audioFiles.length > 0 && (
          <select
            className="admin-select step-edit-panel__audio-select"
            value={variant.audio_file_id ?? ''}
            onChange={(e) =>
              e.target.value
                ? onPickExisting(variant.id, e.target.value)
                : onUnset(variant.id)
            }
            disabled={uploading}
          >
            <option value="">— из загруженных —</option>
            {audioFiles.map((af) => (
              <option key={af.id} value={af.id}>{af.filename}</option>
            ))}
          </select>
        )}
        {variant.audio_file_id && (
          <button
            type="button"
            className="step-edit-panel__cue-delete"
            onClick={() => onUnset(variant.id)}
            title="Очистить аудио"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Cue item: mode selector + content                                 */
/* ------------------------------------------------------------------ */
type CueMode = 'trigger' | 'custom';

function CueEditor({
  cue,
  storyId,
  globalTriggers,
  triggerMap,
  nameVariants,
  onCueUpdated,
  onDelete,
}: {
  cue: StoryNarrationCue;
  storyId: string;
  globalTriggers: Trigger[];
  triggerMap: Map<string, Trigger>;
  nameVariants: StoryNameVariant[];
  onCueUpdated: (cue: StoryNarrationCue) => void;
  onDelete: () => void;
}) {
  const trigger = cue.trigger_id ? triggerMap.get(cue.trigger_id) : undefined;

  // Determine mode: if cue has a trigger and it's an auto-trigger → custom, else if has trigger → trigger, else custom
  const getMode = (): CueMode => {
    if (!cue.trigger_id) return 'custom';
    // If trigger not yet loaded in map, assume custom (will re-derive on next render)
    if (!trigger) return 'custom';
    if (isAutoTrigger(trigger)) return 'custom';
    return 'trigger';
  };

  const [mode, setMode] = useState<CueMode>(getMode);
  const [uploading, setUploading] = useState(false);
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);

  // Load available audio files once
  useEffect(() => {
    adminNarratorApi.listAudioFiles().then((res) => setAudioFiles(res.data.audio_files)).catch(() => {});
  }, []);

  // When cue changes externally, re-derive mode
  useEffect(() => { setMode(getMode()); }, [cue.trigger_id]);

  const handleModeChange = async (newMode: CueMode) => {
    if (newMode === mode) return;
    setMode(newMode);

    if (newMode === 'custom') {
      // Clear trigger reference
      if (cue.trigger_id) {
        try {
          const res = await adminStoriesApi.updateCue(storyId, cue.id, {
            trigger_id: null,
            unset_trigger: true,
          });
          onCueUpdated(res.data);
        } catch {}
      }
    } else {
      // Switching to trigger mode — clear override_text (will pick trigger)
      try {
        const res = await adminStoriesApi.updateCue(storyId, cue.id, {
          override_text: null,
        });
        onCueUpdated(res.data);
      } catch {}
    }
  };

  const handleTriggerSelect = async (triggerId: string) => {
    if (!triggerId) return;
    try {
      const res = await adminStoriesApi.updateCue(storyId, cue.id, { trigger_id: triggerId });
      onCueUpdated(res.data);
    } catch {}
  };

  const handleNameVariantSelect = async (key: string) => {
    try {
      const res = await adminStoriesApi.updateCue(
        storyId,
        cue.id,
        key ? { name_variant_key: key } : { unset_name_variant: true },
      );
      onCueUpdated(res.data);
    } catch {}
  };

  // ---- Custom mode: manage variants via auto-trigger ----
  const autoTrigger = trigger && isAutoTrigger(trigger) ? trigger : null;
  const variants: Variant[] = autoTrigger?.variants || [];

  const ensureAutoTrigger = async (): Promise<string | null> => {
    if (autoTrigger) return autoTrigger.id;
    // Check if auto-trigger already exists in loaded triggers
    const slug = `${AUTO_TRIGGER_PREFIX}${cue.id.slice(0, 8)}`;
    const existing = Array.from(triggerMap.values()).find((t) => t.slug === slug);
    if (existing) {
      // Link cue to existing auto-trigger
      await adminStoriesApi.updateCue(storyId, cue.id, {
        trigger_id: existing.id,
        override_text: null,
      });
      return existing.id;
    }
    // Create auto-trigger for this cue
    try {
      const trigRes = await adminNarratorApi.createTrigger({
        slug,
        story_id: storyId,
        group_key: 'auto_cue',
        label: `Cue ${cue.sort_order + 1}`,
        kind: 'variant',
      });
      // Link cue to this trigger
      await adminStoriesApi.updateCue(storyId, cue.id, {
        trigger_id: trigRes.data.id,
        override_text: null,
      });
      return trigRes.data.id;
    } catch (err: any) {
      // 409 = trigger already exists — find it via API
      if (err?.response?.status === 409) {
        try {
          const listRes = await adminNarratorApi.listTriggers({ story_id: storyId, include_global: false });
          const found = listRes.data.triggers.find((t: Trigger) => t.slug === slug);
          if (found) {
            await adminStoriesApi.updateCue(storyId, cue.id, {
              trigger_id: found.id,
              override_text: null,
            });
            return found.id;
          }
        } catch {}
      }
      return null;
    }
  };

  const handleAddVariant = async () => {
    const trigId = await ensureAutoTrigger();
    if (!trigId) return;
    const sortOrder = variants.length > 0 ? Math.max(...variants.map((v) => v.sort_order)) + 1 : 0;
    try {
      await adminNarratorApi.createVariant(trigId, {
        text: 'Новый вариант',
        sort_order: sortOrder,
      });
      // Refresh trigger
      const updated = await adminNarratorApi.getTrigger(trigId);
      // Re-fetch cue to get fresh trigger_id
      const cueRes = await adminStoriesApi.updateCue(storyId, cue.id, { trigger_id: trigId });
      onCueUpdated(cueRes.data);
      // Trigger map will be updated via parent
      triggerMap.set(trigId, updated.data);
    } catch {}
  };

  const handleVariantTextSaved = async (variantId: string, text: string) => {
    try {
      await adminNarratorApi.updateVariant(variantId, { text });
      if (autoTrigger) {
        const updated = await adminNarratorApi.getTrigger(autoTrigger.id);
        triggerMap.set(autoTrigger.id, updated.data);
        // Force re-render
        onCueUpdated({ ...cue });
      }
    } catch {}
  };

  const handleVariantUploadMp3 = async (variantId: string, file: File) => {
    setUploading(true);
    try {
      let audioFileId: string;
      try {
        const audioRes = await adminNarratorApi.uploadAudioFile(file);
        audioFileId = audioRes.data.id;
      } catch (uploadErr: any) {
        // 409 = файл с таким именем уже есть — найти и переиспользовать
        if (uploadErr?.response?.status === 409) {
          const listRes = await adminNarratorApi.listAudioFiles();
          const existing = listRes.data.audio_files.find(
            (af) => af.filename === file.name,
          );
          if (!existing) throw uploadErr;
          audioFileId = existing.id;
        } else {
          throw uploadErr;
        }
      }
      await adminNarratorApi.updateVariant(variantId, { audio_file_id: audioFileId });
      if (autoTrigger) {
        const updated = await adminNarratorApi.getTrigger(autoTrigger.id);
        triggerMap.set(autoTrigger.id, updated.data);
        onCueUpdated({ ...cue });
      }
    } catch {} finally {
      setUploading(false);
    }
  };

  const handleVariantPickExisting = async (variantId: string, audioFileId: string) => {
    try {
      await adminNarratorApi.updateVariant(variantId, { audio_file_id: audioFileId });
      if (autoTrigger) {
        const updated = await adminNarratorApi.getTrigger(autoTrigger.id);
        triggerMap.set(autoTrigger.id, updated.data);
        onCueUpdated({ ...cue });
      }
    } catch {}
  };

  const handleVariantUnset = async (variantId: string) => {
    try {
      await adminNarratorApi.updateVariant(variantId, { unset_audio: true });
      if (autoTrigger) {
        const updated = await adminNarratorApi.getTrigger(autoTrigger.id);
        triggerMap.set(autoTrigger.id, updated.data);
        onCueUpdated({ ...cue });
      }
    } catch {}
  };

  const handleVariantDelete = async (variantId: string) => {
    try {
      await adminNarratorApi.deleteVariant(variantId);
      if (autoTrigger) {
        const updated = await adminNarratorApi.getTrigger(autoTrigger.id);
        triggerMap.set(autoTrigger.id, updated.data);
        onCueUpdated({ ...cue });
      }
    } catch {}
  };

  const handleVariantMove = async (variantId: string, direction: 'up' | 'down') => {
    const idx = variants.findIndex((v) => v.id === variantId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= variants.length) return;
    // Swap sort_order values
    const a = variants[idx];
    const b = variants[swapIdx];
    try {
      await Promise.all([
        adminNarratorApi.updateVariant(a.id, { sort_order: b.sort_order }),
        adminNarratorApi.updateVariant(b.id, { sort_order: a.sort_order }),
      ]);
      if (autoTrigger) {
        const updated = await adminNarratorApi.getTrigger(autoTrigger.id);
        triggerMap.set(autoTrigger.id, updated.data);
        onCueUpdated({ ...cue });
      }
    } catch {}
  };

  return (
    <div className="step-edit-panel__cue">
      <div className="step-edit-panel__cue-content">
        <div className="step-edit-panel__cue-mode-row">
          <select
            className="step-edit-panel__cue-mode-select"
            value={mode}
            onChange={(e) => handleModeChange(e.target.value as CueMode)}
          >
            <option value="custom">Свои варианты</option>
            <option value="trigger">Триггер</option>
          </select>
          <span className="step-edit-panel__cue-order">#{cue.sort_order + 1}</span>
        </div>

        {mode === 'trigger' && (
          <select
            className="step-edit-panel__cue-trigger"
            value={cue.trigger_id && trigger && !isAutoTrigger(trigger) ? cue.trigger_id : ''}
            onChange={(e) => handleTriggerSelect(e.target.value)}
          >
            <option value="">— Выберите триггер —</option>
            {globalTriggers.map((t) => (
              <option key={t.id} value={t.id}>{t.slug}</option>
            ))}
          </select>
        )}

        {mode === 'custom' && (
          <div className="step-edit-panel__variants-list">
            {variants.length === 0 && (
              <div className="step-edit-panel__empty" style={{ fontSize: 11 }}>
                Нет вариантов. Нажмите + чтобы добавить.
              </div>
            )}
            {variants.map((v, idx) => (
                <VariantRow
                  key={v.id}
                  variant={v}
                  index={idx + 1}
                  total={variants.length}
                  onTextSaved={handleVariantTextSaved}
                  onUploadMp3={handleVariantUploadMp3}
                  onPickExisting={handleVariantPickExisting}
                  onUnset={handleVariantUnset}
                  onDelete={handleVariantDelete}
                  onMoveUp={(id) => handleVariantMove(id, 'up')}
                  onMoveDown={(id) => handleVariantMove(id, 'down')}
                  uploading={uploading}
                  audioFiles={audioFiles}
                />
              ))}
            <button
              type="button"
              className="step-edit-panel__add-variant-btn"
              onClick={handleAddVariant}
            >
              <Plus size={11} /> Добавить вариант
            </button>
          </div>
        )}

        {mode === 'trigger' && !cue.trigger_id && (
          <div className="step-edit-panel__cue-warn">
            <AlertTriangle size={11} />
            <span>Триггер не выбран</span>
          </div>
        )}

        {nameVariants.length > 0 && (
          <div className="step-edit-panel__cue-name-variant">
            <label>Имя между фразами</label>
            <select
              className="admin-select"
              value={cue.name_variant_key ?? ''}
              onChange={(e) => handleNameVariantSelect(e.target.value)}
            >
              <option value="">— без имени —</option>
              {nameVariants.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label ? `${v.label} (${v.key})` : v.key}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <button
        type="button"
        className="step-edit-panel__cue-delete"
        onClick={onDelete}
        title="Удалить фразу"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                        */
/* ------------------------------------------------------------------ */
export default function StepEditPanel({ storyId, step, story, onClose, onStepUpdated, onStoryChanged }: Props) {
  const [label, setLabel] = useState(step.label);
  const [slug, setSlug] = useState(step.slug);
  const [cues, setCues] = useState<StoryNarrationCue[]>(step.cues);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTriggers = useCallback(() => {
    adminNarratorApi
      .listTriggers({ story_id: storyId, include_global: true })
      .then((res) => setTriggers(res.data.triggers))
      .catch(() => {});
  }, [storyId]);

  useEffect(() => { loadTriggers(); }, [loadTriggers]);

  useEffect(() => {
    setLabel(step.label);
    setSlug(step.slug);
    setCues(step.cues);
  }, [step]);

  const handleSaveStep = useCallback(async () => {
    if (label === step.label && slug === step.slug) return;
    setSaving(true);
    setError(null);
    try {
      const res = await adminStoriesApi.updateStep(storyId, step.id, { label, slug });
      onStepUpdated(res.data);
    } catch (err) {
      setError('Не удалось сохранить');
      logger.warn('admin.story.step_update_failed', 'Step update failed', { error: parseApiError(err) });
    } finally {
      setSaving(false);
    }
  }, [storyId, step, label, slug, onStepUpdated]);

  const handleAddCue = useCallback(async () => {
    const sortOrder = cues.length > 0 ? Math.max(...cues.map((c) => c.sort_order)) + 1 : 0;
    const payload: StoryNarrationCueCreatePayload = {
      sort_order: sortOrder,
      pause_before_ms: 0,
      pause_after_ms: 300,
      override_text: 'Новая фраза',
    };
    try {
      const res = await adminStoriesApi.createCue(storyId, step.id, payload);
      const newCues = [...cues, res.data];
      setCues(newCues);
      onStepUpdated({ ...step, cues: newCues });
    } catch (err) {
      const msg = parseApiError(err);
      setError(typeof msg === 'string' ? msg : 'Не удалось добавить фразу');
      logger.warn('admin.story.cue_create_failed', 'Cue create failed', { error: msg });
    }
  }, [storyId, step, cues, onStepUpdated]);

  const isNarration = step.kind === 'narration';

  const handleDeleteCue = useCallback(
    async (cueId: string) => {
      try {
        await adminStoriesApi.deleteCue(storyId, cueId);
        const newCues = cues.filter((c) => c.id !== cueId);
        setCues(newCues);
        onStepUpdated({ ...step, cues: newCues });
      } catch (err) {
        logger.warn('admin.story.cue_delete_failed', 'Cue delete failed', { error: parseApiError(err) });
      }
    },
    [storyId, step, cues, onStepUpdated],
  );

  const handleCueUpdated = useCallback(
    (updated: StoryNarrationCue) => {
      const newCues = cues.map((c) => (c.id === updated.id ? updated : c));
      setCues(newCues);
      onStepUpdated({ ...step, cues: newCues });
      // Reload triggers to pick up any auto-triggers created
      loadTriggers();
    },
    [cues, step, onStepUpdated, loadTriggers],
  );

  // Only show global triggers in the trigger dropdown (not auto-triggers)
  const globalTriggers = triggers.filter((t) => t.story_id === null);
  const triggerMap = new Map(triggers.map((t) => [t.id, t]));
  const nameVariants = story?.name_variants ?? [];

  return (
    <div className="step-edit-panel">
      <div className="step-edit-panel__header">
        <h3>Редактирование шага</h3>
        <button type="button" className="step-edit-panel__close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="step-edit-panel__body">
        {error && <div className="step-edit-panel__error">{error}</div>}

        <div className="step-edit-panel__field">
          <label>Название</label>
          <input
            className="admin-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={handleSaveStep}
            placeholder="Введите название шага..."
          />
        </div>

        <div className="step-edit-panel__field">
          <label>Slug</label>
          <input
            className="admin-input"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onBlur={handleSaveStep}
            placeholder="unique_slug"
          />
        </div>

        <div className="step-edit-panel__field">
          <label>Тип</label>
          <div className="step-edit-panel__kind-badge">{step.kind}</div>
        </div>

        <div className="step-edit-panel__divider" />

        {step.kind === 'names' ? (
          <NamesNodePanel
            storyId={storyId}
            story={story as StoryReadFull}
            onStoryChanged={onStoryChanged}
          />
        ) : step.kind === 'roles' ? (
          <RolesNodePanel
            storyId={storyId}
            story={story as StoryReadFull}
            onStoryChanged={onStoryChanged}
          />
        ) : isNarration ? (
        <div className="step-edit-panel__section">
          <div className="step-edit-panel__section-header">
            <Mic size={14} />
            <span>Фразы ({cues.length})</span>
            <button
              type="button"
              className="step-edit-panel__add-btn"
              onClick={handleAddCue}
              title="Добавить фразу"
            >
              <Plus size={14} />
            </button>
          </div>

          {cues.length === 0 && (
            <div className="step-edit-panel__empty">
              Нет фраз. Нажмите + чтобы добавить.
            </div>
          )}

          <div className="step-edit-panel__cues">
            {cues
              .slice()
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((cue) => (
                <CueEditor
                  key={cue.id}
                  cue={cue}
                  storyId={storyId}
                  globalTriggers={globalTriggers}
                  triggerMap={triggerMap}
                  nameVariants={nameVariants}
                  onCueUpdated={handleCueUpdated}
                  onDelete={() => handleDeleteCue(cue.id)}
                />
              ))}
          </div>
        </div>
        ) : (
          <div className="step-edit-panel__empty">
            Фразы доступны только для шагов типа «narration».
          </div>
        )}
      </div>
    </div>
  );
}
