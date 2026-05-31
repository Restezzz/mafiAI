/**
 * Панель ноды «Имена» (имена пер-сюжет + варианты произношения).
 *
 * Сверху — управление БАЗОВЫМ набором имён сюжета (`story.names`): добавить /
 * удалить / переименовать имя + дефолтное mp3 произношения. Игрок на фазе
 * `name_pick` выбирает имя именно из этого набора.
 *
 * Ниже — варианты произношения имён (story-scoped): каждый вариант имеет ключ
 * (например `voting`) и набор mp3 — по одному на каждое имя сюжета. В нодах
 * нарратива cue ссылается на вариант по ключу, и backend вставляет
 * соответствующее mp3 между фразами при озвучке имени.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload, Play, Square, X } from 'lucide-react';
import {
  adminStoriesApi,
  StoryName,
  StoryNameVariant,
  StoryReadFull,
} from '../../../api/adminStoriesApi';
import { adminNarratorApi } from '../../../api/adminNarratorApi';
import { AudioFile } from '../../../types/narrator';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';
import { API_BASE_URL } from '../../../utils/constants';

interface Props {
  storyId: string;
  story: StoryReadFull;
  onStoryChanged: () => void;
}

function MiniPlayer({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    if (!ref.current) return;
    if (playing) {
      ref.current.pause();
      setPlaying(false);
    } else {
      ref.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  };
  return (
    <span className="step-edit-panel__mini-player">
      <audio
        ref={ref}
        src={`${API_BASE_URL}${src}`}
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function NameDescriptionField({
  value,
  onSave,
}: {
  value: string;
  onSave: (description: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <textarea
      className="admin-input step-edit-panel__name-desc"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (value !== text) onSave(text);
      }}
      placeholder="Описание имени (показывается при выборе; необязательно)"
      rows={2}
    />
  );
}

export default function NamesNodePanel({ storyId, story, onStoryChanged }: Props) {
  const names = story.names;
  const variants = story.name_variants;
  const [selectedId, setSelectedId] = useState<string | null>(
    variants[0]?.id ?? null,
  );
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newName, setNewName] = useState('');
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminNarratorApi
      .listAudioFiles()
      .then((res) => setAudioFiles(res.data.audio_files))
      .catch(() => {});
  }, []);

  // Держим selectedId валидным при изменении списка вариантов.
  useEffect(() => {
    if (selectedId && !variants.some((v) => v.id === selectedId)) {
      setSelectedId(variants[0]?.id ?? null);
    } else if (!selectedId && variants.length > 0) {
      setSelectedId(variants[0].id);
    }
  }, [variants, selectedId]);

  const selected: StoryNameVariant | undefined = variants.find(
    (v) => v.id === selectedId,
  );

  const handleAddName = useCallback(async () => {
    const display = newName.trim();
    if (!display) {
      setNameError('Введите имя');
      return;
    }
    const key = slugify(display) || `name_${names.length + 1}`;
    setNameError(null);
    try {
      await adminStoriesApi.createStoryName(storyId, {
        key,
        display_name: display,
        sort_order: names.length,
      });
      setNewName('');
      onStoryChanged();
    } catch (err) {
      const msg = parseApiError(err);
      setNameError(typeof msg === 'string' ? msg : 'Не удалось добавить имя');
      logger.warn('admin.story.name_create_failed', 'create name failed', {
        error: msg,
      });
    }
  }, [storyId, newName, names.length, onStoryChanged]);

  const handleDeleteName = useCallback(
    async (nameId: string) => {
      try {
        await adminStoriesApi.deleteStoryName(storyId, nameId);
        onStoryChanged();
      } catch (err) {
        logger.warn('admin.story.name_delete_failed', 'delete name failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, onStoryChanged],
  );

  const setBaseAudio = useCallback(
    async (nameId: string, audioFileId: string | null) => {
      try {
        await adminStoriesApi.updateStoryName(
          storyId,
          nameId,
          audioFileId
            ? { base_audio_file_id: audioFileId }
            : { unset_base_audio: true },
        );
        onStoryChanged();
      } catch (err) {
        logger.warn('admin.story.name_base_audio_failed', 'set base audio failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, onStoryChanged],
  );

  const setNameDescription = useCallback(
    async (nameId: string, description: string) => {
      const trimmed = description.trim();
      try {
        await adminStoriesApi.updateStoryName(
          storyId,
          nameId,
          trimmed ? { description: trimmed } : { unset_description: true },
        );
        onStoryChanged();
      } catch (err) {
        logger.warn('admin.story.name_description_failed', 'set description failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, onStoryChanged],
  );

  const handleUploadBase = useCallback(
    async (nameId: string, file: File) => {
      setUploadingFor(`base:${nameId}`);
      try {
        let audioFileId: string;
        try {
          const res = await adminNarratorApi.uploadAudioFile(file);
          audioFileId = res.data.id;
        } catch (uploadErr: any) {
          if (uploadErr?.response?.status === 409) {
            const list = await adminNarratorApi.listAudioFiles();
            const existing = list.data.audio_files.find(
              (af) => af.filename === file.name,
            );
            if (!existing) throw uploadErr;
            audioFileId = existing.id;
          } else {
            throw uploadErr;
          }
        }
        await setBaseAudio(nameId, audioFileId);
        const list = await adminNarratorApi.listAudioFiles();
        setAudioFiles(list.data.audio_files);
      } catch (err) {
        logger.warn('admin.story.name_base_upload_failed', 'upload base failed', {
          error: parseApiError(err),
        });
      } finally {
        setUploadingFor(null);
      }
    },
    [setBaseAudio],
  );

  const handleAddVariant = useCallback(async () => {
    const key = newKey.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(key)) {
      setError('Ключ должен быть [a-z0-9_], 1..40 символов');
      return;
    }
    setError(null);
    try {
      const res = await adminStoriesApi.createNameVariant(storyId, {
        key,
        label: newLabel.trim(),
        sort_order: variants.length,
      });
      setNewKey('');
      setNewLabel('');
      setSelectedId(res.data.id);
      onStoryChanged();
    } catch (err) {
      const msg = parseApiError(err);
      setError(typeof msg === 'string' ? msg : 'Не удалось создать вариант');
      logger.warn('admin.story.name_variant_create_failed', 'create failed', {
        error: msg,
      });
    }
  }, [storyId, newKey, newLabel, variants.length, onStoryChanged]);

  const handleDeleteVariant = useCallback(
    async (variantId: string) => {
      try {
        await adminStoriesApi.deleteNameVariant(storyId, variantId);
        onStoryChanged();
      } catch (err) {
        logger.warn('admin.story.name_variant_delete_failed', 'delete failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, onStoryChanged],
  );

  const setAsset = useCallback(
    async (
      variantId: string,
      storyNameId: string,
      audioFileId: string | null,
    ) => {
      try {
        await adminStoriesApi.setNameVariantAsset(
          storyId,
          variantId,
          storyNameId,
          audioFileId ? { audio_file_id: audioFileId } : { unset_audio: true },
        );
        onStoryChanged();
      } catch (err) {
        logger.warn('admin.story.name_variant_asset_failed', 'set asset failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, onStoryChanged],
  );

  const handleUpload = useCallback(
    async (variantId: string, storyNameId: string, file: File) => {
      setUploadingFor(storyNameId);
      try {
        let audioFileId: string;
        try {
          const res = await adminNarratorApi.uploadAudioFile(file);
          audioFileId = res.data.id;
        } catch (uploadErr: any) {
          if (uploadErr?.response?.status === 409) {
            const list = await adminNarratorApi.listAudioFiles();
            const existing = list.data.audio_files.find(
              (af) => af.filename === file.name,
            );
            if (!existing) throw uploadErr;
            audioFileId = existing.id;
          } else {
            throw uploadErr;
          }
        }
        await setAsset(variantId, storyNameId, audioFileId);
        const list = await adminNarratorApi.listAudioFiles();
        setAudioFiles(list.data.audio_files);
      } catch (err) {
        logger.warn('admin.story.name_variant_upload_failed', 'upload failed', {
          error: parseApiError(err),
        });
      } finally {
        setUploadingFor(null);
      }
    },
    [setAsset],
  );

  return (
    <div className="step-edit-panel__section">
      <div className="step-edit-panel__section-header">
        <span>Имена сюжета</span>
      </div>

      {nameError && <div className="step-edit-panel__error">{nameError}</div>}

      <div className="step-edit-panel__field">
        <label>Добавить имя</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="admin-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddName();
            }}
            placeholder="имя (напр. Анна)"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="step-edit-panel__add-btn"
            onClick={handleAddName}
            title="Добавить имя"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {names.length === 0 && (
        <div className="step-edit-panel__empty">
          У сюжета нет своих имён — используется общий каталог озвучки.
          Добавьте имена, чтобы игроки выбирали из набора этого сюжета.
        </div>
      )}

      {names.length > 0 && (
        <div className="step-edit-panel__cues">
          {names.map((n: StoryName) => (
            <div key={n.id} className="step-edit-panel__variant">
              <div className="step-edit-panel__variant-header">
                <span className="step-edit-panel__variant-label">
                  {n.display_name}
                </span>
                <div className="step-edit-panel__variant-controls">
                  {n.base_audio_url && <MiniPlayer src={n.base_audio_url} />}
                  {n.base_audio_file_id && (
                    <button
                      type="button"
                      className="step-edit-panel__cue-delete"
                      onClick={() => setBaseAudio(n.id, null)}
                      title="Очистить аудио"
                    >
                      <X size={11} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="step-edit-panel__cue-delete"
                    onClick={() => handleDeleteName(n.id)}
                    title="Удалить имя"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="step-edit-panel__variant-audio">
                <label className="step-edit-panel__upload-label">
                  <Upload size={12} />
                  <span>{n.base_audio_filename ? 'Заменить' : 'Загрузить'}</span>
                  <input
                    type="file"
                    accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUploadBase(n.id, f);
                    }}
                    disabled={uploadingFor === `base:${n.id}`}
                    style={{ display: 'none' }}
                  />
                </label>
                {audioFiles.length > 0 && (
                  <select
                    className="admin-select step-edit-panel__audio-select"
                    value={n.base_audio_file_id ?? ''}
                    onChange={(e) => setBaseAudio(n.id, e.target.value || null)}
                    disabled={uploadingFor === `base:${n.id}`}
                  >
                    <option value="">— из загруженных —</option>
                    {audioFiles.map((af) => (
                      <option key={af.id} value={af.id}>
                        {af.filename}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <NameDescriptionField
                value={n.description ?? ''}
                onSave={(desc) => setNameDescription(n.id, desc)}
              />
            </div>
          ))}
        </div>
      )}

      <div
        className="step-edit-panel__section-header"
        style={{ marginTop: 16 }}
      >
        <span>Варианты произношения имён</span>
      </div>

      {error && <div className="step-edit-panel__error">{error}</div>}

      <div className="step-edit-panel__field">
        <label>Добавить вариант</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="admin-input"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="ключ (напр. voting)"
            style={{ flex: 1 }}
          />
          <input
            className="admin-input"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="название"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="step-edit-panel__add-btn"
            onClick={handleAddVariant}
            title="Добавить вариант"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {variants.length === 0 && (
        <div className="step-edit-panel__empty">
          Нет вариантов. Добавьте вариант выше.
        </div>
      )}

      {variants.length > 0 && (
        <div className="step-edit-panel__field">
          <label>Вариант</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              className="admin-select"
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
              style={{ flex: 1 }}
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label ? `${v.label} (${v.key})` : v.key}
                </option>
              ))}
            </select>
            {selected && (
              <button
                type="button"
                className="step-edit-panel__cue-delete"
                onClick={() => handleDeleteVariant(selected.id)}
                title="Удалить вариант"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {selected && (
        <div className="step-edit-panel__cues">
          {selected.assets.length === 0 && (
            <div className="step-edit-panel__empty">
              В наборе имён сюжета пусто. Добавьте имена выше.
            </div>
          )}
          {selected.assets.map((a) => (
            <div key={a.story_name_id} className="step-edit-panel__variant">
              <div className="step-edit-panel__variant-header">
                <span className="step-edit-panel__variant-label">
                  {a.display_name}
                </span>
                <div className="step-edit-panel__variant-controls">
                  {a.audio_url && <MiniPlayer src={a.audio_url} />}
                  {a.audio_file_id && (
                    <button
                      type="button"
                      className="step-edit-panel__cue-delete"
                      onClick={() => setAsset(selected.id, a.story_name_id, null)}
                      title="Очистить аудио"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
              <div className="step-edit-panel__variant-audio">
                <label className="step-edit-panel__upload-label">
                  <Upload size={12} />
                  <span>{a.audio_filename ? 'Заменить' : 'Загрузить'}</span>
                  <input
                    type="file"
                    accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(selected.id, a.story_name_id, f);
                    }}
                    disabled={uploadingFor === a.story_name_id}
                    style={{ display: 'none' }}
                  />
                </label>
                {audioFiles.length > 0 && (
                  <select
                    className="admin-select step-edit-panel__audio-select"
                    value={a.audio_file_id ?? ''}
                    onChange={(e) =>
                      setAsset(
                        selected.id,
                        a.story_name_id,
                        e.target.value || null,
                      )
                    }
                    disabled={uploadingFor === a.story_name_id}
                  >
                    <option value="">— из загруженных —</option>
                    {audioFiles.map((af) => (
                      <option key={af.id} value={af.id}>
                        {af.filename}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
