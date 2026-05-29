/**
 * Панель ноды «Имена» (фича 1).
 *
 * Управляет вариантами произношения имён (story-scoped): каждый вариант
 * имеет ключ (например `voting`) и набор mp3 — по одному на каждое имя из
 * глобального каталога. В нодах нарратива cue ссылается на вариант по ключу,
 * и backend вставляет соответствующее mp3 между фразами при озвучке имени.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload, Play, Square, X } from 'lucide-react';
import {
  adminStoriesApi,
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

export default function NamesNodePanel({ storyId, story, onStoryChanged }: Props) {
  const variants = story.name_variants;
  const [selectedId, setSelectedId] = useState<string | null>(
    variants[0]?.id ?? null,
  );
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
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
      nameAssetId: string,
      audioFileId: string | null,
    ) => {
      try {
        await adminStoriesApi.setNameVariantAsset(
          storyId,
          variantId,
          nameAssetId,
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
    async (variantId: string, nameAssetId: string, file: File) => {
      setUploadingFor(nameAssetId);
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
        await setAsset(variantId, nameAssetId, audioFileId);
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
              В каталоге нет имён.
            </div>
          )}
          {selected.assets.map((a) => (
            <div key={a.name_asset_id} className="step-edit-panel__variant">
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
                      onClick={() => setAsset(selected.id, a.name_asset_id, null)}
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
                      if (f) handleUpload(selected.id, a.name_asset_id, f);
                    }}
                    disabled={uploadingFor === a.name_asset_id}
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
                        a.name_asset_id,
                        e.target.value || null,
                      )
                    }
                    disabled={uploadingFor === a.name_asset_id}
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
