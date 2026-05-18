import React, { useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import {
  AudioFile,
  CompositeSegment,
  PlaceholderInfo,
  SegmentKind,
} from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import AudioSelect from './AudioSelect';
import AudioPlayer from './AudioPlayer';

type Props =
  | {
      mode: 'create';
      templateId: string;
      segment?: undefined;
      defaultPosition: number;
      audioFiles: AudioFile[];
      placeholders: PlaceholderInfo[];
      onSaved: () => void | Promise<void>;
      onCancel: () => void;
    }
  | {
      mode: 'edit';
      templateId?: undefined;
      segment: CompositeSegment;
      defaultPosition?: undefined;
      audioFiles: AudioFile[];
      placeholders: PlaceholderInfo[];
      onSaved: () => void | Promise<void>;
      onCancel: () => void;
    };

/**
 * Редактор одного segment'а. Инварианты:
 * - kind='audio' → audio_file_id обязателен, placeholder_key пустой.
 * - kind='placeholder' → placeholder_key обязателен, audio_file_id пустой.
 *
 * Backend жёстко валидирует это, поэтому UI просто скрывает несоответствующие
 * поля — соблюдать инварианты будет проще.
 */
export default function SegmentEditor(props: Props) {
  const { mode, audioFiles, placeholders, onSaved, onCancel } = props;

  const [kind, setKind] = useState<SegmentKind>(
    mode === 'edit' ? props.segment.kind : 'audio',
  );
  const [position, setPosition] = useState<number>(
    mode === 'edit' ? props.segment.position : props.defaultPosition,
  );
  const [audioFileId, setAudioFileId] = useState<string | null>(
    mode === 'edit' ? props.segment.audio_file_id : null,
  );
  const [placeholderKey, setPlaceholderKey] = useState<string | null>(
    mode === 'edit' ? props.segment.placeholder_key : null,
  );
  const [textFragment, setTextFragment] = useState<string>(
    mode === 'edit' ? props.segment.text_fragment : '',
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSave =
    kind === 'audio' ? !!audioFileId : !!placeholderKey;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (mode === 'create') {
        await adminNarratorApi.createSegment(props.templateId, {
          position,
          kind,
          audio_file_id: kind === 'audio' ? audioFileId : null,
          placeholder_key: kind === 'placeholder' ? placeholderKey : null,
          text_fragment: textFragment,
        });
      } else {
        // PATCH-стиль: послать всё, чтобы пересобрать сегмент. unset_audio даёт
        // явный сигнал backend'у при смене audio → placeholder.
        await adminNarratorApi.updateSegment(props.segment.id, {
          position,
          kind,
          unset_audio: kind === 'placeholder',
          audio_file_id: kind === 'audio' ? audioFileId : undefined,
          placeholder_key: kind === 'placeholder' ? placeholderKey ?? '' : '',
          text_fragment: textFragment,
        });
      }
      await onSaved();
    } catch (err) {
      logger.warn('admin.segment.save_failed', 'Failed to save segment', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось сохранить сегмент');
    } finally {
      setSaving(false);
    }
  };

  const currentAudio = audioFiles.find((a) => a.id === audioFileId);

  return (
    <div
      style={{
        background: '#161719',
        border: '1px solid rgba(200, 30, 30, 0.3)',
        borderRadius: 4,
        padding: 14,
      }}
    >
      <div style={{ fontSize: '0.85rem', color: '#8c8f95', marginBottom: 12 }}>
        {mode === 'create' ? 'Новый сегмент' : 'Редактирование сегмента'}
      </div>

      <div className="admin-row" style={{ alignItems: 'flex-start' }}>
        <div className="admin-field" style={{ width: 130 }}>
          <label className="admin-field__label">Position</label>
          <input
            className="admin-input"
            type="number"
            min={0}
            value={position}
            onChange={(e) => setPosition(parseInt(e.target.value, 10) || 0)}
            disabled={saving}
          />
          <div className="admin-field__hint">порядок в шаблоне</div>
        </div>

        <div className="admin-field" style={{ flex: 1, minWidth: 160 }}>
          <label className="admin-field__label">Тип сегмента</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`admin-btn admin-btn--small${kind === 'audio' ? ' admin-btn--primary' : ''}`}
              onClick={() => setKind('audio')}
              disabled={saving}
              style={{ flex: 1 }}
            >
              audio
            </button>
            <button
              type="button"
              className={`admin-btn admin-btn--small${kind === 'placeholder' ? ' admin-btn--primary' : ''}`}
              onClick={() => setKind('placeholder')}
              disabled={saving}
              style={{ flex: 1 }}
            >
              placeholder
            </button>
          </div>
        </div>
      </div>

      {kind === 'audio' && (
        <div className="admin-field">
          <label className="admin-field__label">Аудио (mp3)</label>
          <AudioSelect
            audioFiles={audioFiles}
            value={audioFileId}
            onChange={setAudioFileId}
            disabled={saving}
          />
          {currentAudio && (
            <div style={{ marginTop: 8 }}>
              <AudioPlayer url={currentAudio.url} label={currentAudio.filename} size="small" />
            </div>
          )}
        </div>
      )}

      {kind === 'placeholder' && (
        <div className="admin-field">
          <label className="admin-field__label">Placeholder</label>
          <select
            className="admin-select"
            value={placeholderKey ?? ''}
            onChange={(e) => setPlaceholderKey(e.target.value || null)}
            disabled={saving}
          >
            <option value="">— выберите —</option>
            {placeholders.map((p) => (
              <option key={p.key} value={p.key}>
                {`{${p.key}}`} — {p.label}
              </option>
            ))}
          </select>
          {placeholderKey && (
            <div className="admin-field__hint">
              {placeholders.find((p) => p.key === placeholderKey)?.description}
            </div>
          )}
        </div>
      )}

      <div className="admin-field">
        <label className="admin-field__label">Текстовый фрагмент (опционально)</label>
        <input
          className="admin-input"
          value={textFragment}
          onChange={(e) => setTextFragment(e.target.value)}
          disabled={saving}
          placeholder='Например: ", вы выбраны"'
        />
        <div className="admin-field__hint">
          Добавится к тексту сегмента в превью. Для синхронизации с TTS / typewriter.
        </div>
      </div>

      {error && <div className="admin-error-banner">{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="admin-btn admin-btn--primary"
          onClick={handleSave}
          disabled={saving || !canSave}
        >
          {saving ? 'Сохранение…' : mode === 'create' ? 'Создать' : 'Сохранить'}
        </button>
        <button className="admin-btn admin-btn--ghost" onClick={onCancel} disabled={saving}>
          Отмена
        </button>
      </div>
    </div>
  );
}
