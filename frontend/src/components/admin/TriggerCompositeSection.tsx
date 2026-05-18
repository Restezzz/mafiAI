import React, { useEffect, useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import {
  AudioFile,
  CompositeTemplate,
  PlaceholderInfo,
  Trigger,
} from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import CompositeTemplateCard from './CompositeTemplateCard';

interface Props {
  trigger: Trigger;
  onChanged: () => void | Promise<void>;
}

/**
 * Секция с composite-шаблонами. Один триггер может иметь несколько
 * шаблонов (например, разные стилистические вариации одной и той же
 * фразы), при срабатывании в runtime выбирается один по seed.
 */
export default function TriggerCompositeSection({ trigger, onChanged }: Props) {
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [placeholders, setPlaceholders] = useState<PlaceholderInfo[]>([]);
  const [auxLoading, setAuxLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [sortDraft, setSortDraft] = useState(0);
  const [createError, setCreateError] = useState('');
  const [createSaving, setCreateSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      adminNarratorApi.listAudioFiles(),
      adminNarratorApi.listPlaceholders(),
    ])
      .then(([a, p]) => {
        if (cancelled) return;
        setAudioFiles(a.data.audio_files);
        setPlaceholders(p.data.placeholders);
      })
      .catch((err) => {
        logger.warn('admin.composite.aux_load_failed', 'Failed to load audio/placeholders', {
          error: parseApiError(err),
        });
      })
      .finally(() => {
        if (!cancelled) setAuxLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedTemplates = [...trigger.composite_templates].sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  const handleCreateTemplate = async () => {
    setCreateSaving(true);
    setCreateError('');
    try {
      await adminNarratorApi.createTemplate(trigger.id, {
        label: labelDraft.trim() || null,
        sort_order: sortDraft,
      });
      setCreating(false);
      setLabelDraft('');
      setSortDraft(0);
      await onChanged();
    } catch (err) {
      logger.warn('admin.template.create_failed', 'Failed to create composite template', {
        error: parseApiError(err),
      });
      setCreateError(getApiErrorMessage(err) ?? 'Не удалось создать шаблон');
    } finally {
      setCreateSaving(false);
    }
  };

  const handleDeleteTemplate = async (template: CompositeTemplate) => {
    const labelStr = template.label ? `"${template.label}"` : '(без названия)';
    if (
      !window.confirm(
        `Удалить шаблон ${labelStr}?\n\nВсе ${template.segments.length} сегмента тоже будут удалены.`,
      )
    ) {
      return;
    }
    setError('');
    try {
      await adminNarratorApi.deleteTemplate(template.id);
      await onChanged();
    } catch (err) {
      logger.warn('admin.template.delete_failed', 'Failed to delete composite template', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить шаблон');
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
          Composite-шаблоны{' '}
          <span style={{ color: '#8c8f95', fontWeight: 400 }}>
            ({sortedTemplates.length})
          </span>
        </h2>
        {!creating && (
          <button
            className="admin-btn admin-btn--primary admin-btn--small"
            onClick={() => setCreating(true)}
            disabled={auxLoading}
          >
            + Добавить шаблон
          </button>
        )}
      </div>

      {error && <div className="admin-error-banner">{error}</div>}

      {creating && (
        <div
          style={{
            background: '#161719',
            border: '1px solid rgba(200, 30, 30, 0.3)',
            borderRadius: 6,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: '0.85rem', color: '#8c8f95', marginBottom: 12 }}>
            Новый шаблон
          </div>
          <div className="admin-field">
            <label className="admin-field__label">Label (необязательно)</label>
            <input
              className="admin-input"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              disabled={createSaving}
              placeholder="Напр. «вариация 2»"
            />
          </div>
          <div className="admin-field" style={{ maxWidth: 160 }}>
            <label className="admin-field__label">Sort order</label>
            <input
              className="admin-input"
              type="number"
              min={0}
              value={sortDraft}
              onChange={(e) => setSortDraft(parseInt(e.target.value, 10) || 0)}
              disabled={createSaving}
            />
          </div>
          {createError && <div className="admin-error-banner">{createError}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="admin-btn admin-btn--primary"
              onClick={handleCreateTemplate}
              disabled={createSaving}
            >
              {createSaving ? 'Сохранение…' : 'Создать'}
            </button>
            <button
              className="admin-btn admin-btn--ghost"
              onClick={() => setCreating(false)}
              disabled={createSaving}
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {sortedTemplates.length === 0 && !creating && (
        <div
          style={{
            padding: 24,
            textAlign: 'center',
            color: '#8c8f95',
            fontSize: '0.9rem',
          }}
        >
          Шаблонов пока нет. Создайте первый.
        </div>
      )}

      <div className="admin-stack">
        {sortedTemplates.map((tpl) => (
          <CompositeTemplateCard
            key={tpl.id}
            template={tpl}
            audioFiles={audioFiles}
            placeholders={placeholders}
            onChanged={onChanged}
            onDelete={() => handleDeleteTemplate(tpl)}
          />
        ))}
      </div>
    </div>
  );
}
