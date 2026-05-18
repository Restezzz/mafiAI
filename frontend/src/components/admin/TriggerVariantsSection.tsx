import React, { useEffect, useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { AudioFile, Trigger, Variant } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import AudioPlayer from './AudioPlayer';
import VariantEditor from './VariantEditor';

interface Props {
  trigger: Trigger;
  onChanged: () => void | Promise<void>;
}

/**
 * Секция с вариантами для variant-триггера. Список + inline-редактор
 * (текст / выбор audio / sort_order) + добавление нового варианта.
 */
export default function TriggerVariantsSection({ trigger, onChanged }: Props) {
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [audioLoading, setAudioLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Audio files грузим один раз — нужны для селектора в editor'е.
  useEffect(() => {
    let cancelled = false;
    adminNarratorApi
      .listAudioFiles()
      .then(({ data }) => {
        if (!cancelled) setAudioFiles(data.audio_files);
      })
      .catch((err) => {
        logger.warn('admin.audio_files.load_failed', 'Failed to load audio files', {
          error: parseApiError(err),
        });
      })
      .finally(() => {
        if (!cancelled) setAudioLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedVariants = [...trigger.variants].sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  const handleDeleteVariant = async (v: Variant) => {
    if (!window.confirm(`Удалить вариант "${v.text.slice(0, 60)}…"?`)) return;
    setBusyId(v.id);
    setError('');
    try {
      await adminNarratorApi.deleteVariant(v.id);
      await onChanged();
    } catch (err) {
      logger.warn('admin.variant.delete_failed', 'Failed to delete variant', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить вариант');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="admin-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>
          Варианты <span style={{ color: '#8c8f95', fontWeight: 400 }}>
            ({sortedVariants.length})
          </span>
        </h2>
        {!creating && editingId === null && (
          <button
            className="admin-btn admin-btn--primary admin-btn--small"
            onClick={() => setCreating(true)}
            disabled={audioLoading}
          >
            + Добавить вариант
          </button>
        )}
      </div>

      {error && <div className="admin-error-banner">{error}</div>}

      {creating && (
        <VariantEditor
          mode="create"
          triggerId={trigger.id}
          audioFiles={audioFiles}
          onSaved={async () => {
            setCreating(false);
            await onChanged();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {sortedVariants.length === 0 && !creating && (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            color: '#8c8f95',
            fontSize: '0.9rem',
          }}
        >
          Вариантов пока нет. Добавьте первый.
        </div>
      )}

      <div className="admin-stack" style={{ marginTop: creating ? 16 : 0 }}>
        {sortedVariants.map((v) => {
          if (editingId === v.id) {
            return (
              <VariantEditor
                key={v.id}
                mode="edit"
                variant={v}
                audioFiles={audioFiles}
                onSaved={async () => {
                  setEditingId(null);
                  await onChanged();
                }}
                onCancel={() => setEditingId(null)}
              />
            );
          }
          return (
            <VariantRow
              key={v.id}
              variant={v}
              busy={busyId === v.id}
              onEdit={() => setEditingId(v.id)}
              onDelete={() => handleDeleteVariant(v)}
            />
          );
        })}
      </div>
    </div>
  );
}

function VariantRow({
  variant,
  busy,
  onEdit,
  onDelete,
}: {
  variant: Variant;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        background: '#0d0e10',
        border: '1px solid #2a2c30',
        borderRadius: 6,
        padding: 14,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginBottom: 6,
              flexWrap: 'wrap',
            }}
          >
            <span className="admin-pill" style={{ fontSize: '0.72rem' }}>
              order {variant.sort_order}
            </span>
            {variant.audio_url ? (
              <AudioPlayer url={variant.audio_url} size="small" />
            ) : (
              <span className="admin-pill admin-pill--placeholder">text-only</span>
            )}
            {variant.duration_ms != null && (
              <span style={{ fontSize: '0.75rem', color: '#8c8f95' }}>
                {(variant.duration_ms / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: '0.92rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {variant.text}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            className="admin-btn admin-btn--small"
            onClick={onEdit}
            disabled={busy}
          >
            Изменить
          </button>
          <button
            className="admin-btn admin-btn--small admin-btn--danger"
            onClick={onDelete}
            disabled={busy}
          >
            {busy ? '…' : 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  );
}
