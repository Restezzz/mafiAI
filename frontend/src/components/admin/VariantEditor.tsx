import React, { useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { AudioFile, Variant } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import AudioPlayer from './AudioPlayer';
import AudioSelect from './AudioSelect';

type Props =
  | {
      mode: 'create';
      triggerId: string;
      variant?: undefined;
      audioFiles: AudioFile[];
      onSaved: () => void | Promise<void>;
      onCancel: () => void;
    }
  | {
      mode: 'edit';
      triggerId?: undefined;
      variant: Variant;
      audioFiles: AudioFile[];
      onSaved: () => void | Promise<void>;
      onCancel: () => void;
    };

export default function VariantEditor(props: Props) {
  const { mode, audioFiles, onSaved, onCancel } = props;

  const [text, setText] = useState(mode === 'edit' ? props.variant.text : '');
  const [sortOrder, setSortOrder] = useState<number>(
    mode === 'edit' ? props.variant.sort_order : 0,
  );
  const [audioFileId, setAudioFileId] = useState<string | null>(
    mode === 'edit' ? props.variant.audio_file_id : null,
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (mode === 'create') {
        await adminNarratorApi.createVariant(props.triggerId, {
          text: text.trim(),
          sort_order: sortOrder,
          audio_file_id: audioFileId,
        });
      } else {
        await adminNarratorApi.updateVariant(props.variant.id, {
          text: text.trim(),
          sort_order: sortOrder,
          // null -> сбросить аудио, otherwise — назначить
          unset_audio: audioFileId === null,
          audio_file_id: audioFileId ?? undefined,
        });
      }
      await onSaved();
    } catch (err) {
      logger.warn('admin.variant.save_failed', 'Failed to save variant', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось сохранить вариант');
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
        borderRadius: 6,
        padding: 16,
      }}
    >
      <div style={{ fontSize: '0.85rem', color: '#8c8f95', marginBottom: 12 }}>
        {mode === 'create' ? 'Новый вариант' : 'Редактирование варианта'}
      </div>

      <div className="admin-field">
        <label className="admin-field__label">Текст реплики</label>
        <textarea
          className="admin-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={saving}
          rows={4}
          placeholder="Например: Город засыпает…"
        />
        <div className="admin-field__hint">
          Может содержать <code>{'{player_name}'}</code>, <code>{'{eliminated_name}'}</code>{' '}
          и другие placeholder'ы из каталога — они подставятся в runtime.
        </div>
      </div>

      <div className="admin-row" style={{ alignItems: 'flex-start' }}>
        <div className="admin-field" style={{ flex: 1, minWidth: 240 }}>
          <label className="admin-field__label">Аудио (mp3)</label>
          <AudioSelect
            audioFiles={audioFiles}
            value={audioFileId}
            onChange={setAudioFileId}
            disabled={saving}
            allowEmpty
          />
          <div className="admin-field__hint">
            Не выбирать — text-only вариант (typewriter без mp3).
          </div>
          {currentAudio && (
            <div style={{ marginTop: 8 }}>
              <AudioPlayer url={currentAudio.url} label={currentAudio.filename} size="small" />
            </div>
          )}
        </div>

        <div className="admin-field" style={{ width: 120 }}>
          <label className="admin-field__label">Sort order</label>
          <input
            className="admin-input"
            type="number"
            min={0}
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            disabled={saving}
          />
        </div>
      </div>

      {error && <div className="admin-error-banner">{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          className="admin-btn admin-btn--primary"
          onClick={handleSave}
          disabled={saving || text.trim().length === 0}
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
