import React, { useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import {
  AudioFile,
  CompositeSegment,
  CompositeTemplate,
  PlaceholderInfo,
} from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import AudioPlayer from './AudioPlayer';
import SegmentEditor from './SegmentEditor';

interface Props {
  template: CompositeTemplate;
  audioFiles: AudioFile[];
  placeholders: PlaceholderInfo[];
  onChanged: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

export default function CompositeTemplateCard({
  template,
  audioFiles,
  placeholders,
  onChanged,
  onDelete,
}: Props) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(template.label ?? '');
  const [sortDraft, setSortDraft] = useState(template.sort_order);
  const [labelSaving, setLabelSaving] = useState(false);
  const [labelError, setLabelError] = useState('');

  const [addingSegment, setAddingSegment] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [segError, setSegError] = useState('');
  const [busySegId, setBusySegId] = useState<string | null>(null);

  const sortedSegments = [...template.segments].sort((a, b) => a.position - b.position);

  const saveLabel = async () => {
    setLabelSaving(true);
    setLabelError('');
    try {
      await adminNarratorApi.updateTemplate(template.id, {
        label: labelDraft.trim() || null,
        sort_order: sortDraft,
      });
      setEditingLabel(false);
      await onChanged();
    } catch (err) {
      logger.warn('admin.template.update_failed', 'Failed to update composite template', {
        error: parseApiError(err),
      });
      setLabelError(getApiErrorMessage(err) ?? 'Не удалось сохранить');
    } finally {
      setLabelSaving(false);
    }
  };

  const handleDeleteSegment = async (seg: CompositeSegment) => {
    if (!window.confirm(`Удалить сегмент #${seg.position}?`)) return;
    setBusySegId(seg.id);
    setSegError('');
    try {
      await adminNarratorApi.deleteSegment(seg.id);
      await onChanged();
    } catch (err) {
      logger.warn('admin.segment.delete_failed', 'Failed to delete segment', {
        error: parseApiError(err),
      });
      setSegError(getApiErrorMessage(err) ?? 'Не удалось удалить сегмент');
    } finally {
      setBusySegId(null);
    }
  };

  // Подсказка: следующая свободная position (max+1).
  const nextPosition = sortedSegments.length
    ? Math.max(...sortedSegments.map((s) => s.position)) + 1
    : 0;

  return (
    <div
      style={{
        background: '#0d0e10',
        border: '1px solid #2a2c30',
        borderRadius: 6,
        padding: 16,
      }}
    >
      {/* Заголовок шаблона */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        {!editingLabel ? (
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {template.label || (
                <span style={{ color: '#8c8f95', fontStyle: 'italic' }}>
                  (без названия)
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.78rem', color: '#8c8f95' }}>
              sort_order {template.sort_order} • {sortedSegments.length} сегмент
              {sortedSegments.length === 1 ? '' : sortedSegments.length < 5 ? 'а' : 'ов'}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minWidth: 240 }}>
            <input
              className="admin-input"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              placeholder="Label"
              disabled={labelSaving}
              style={{ marginBottom: 6 }}
            />
            <input
              className="admin-input"
              type="number"
              value={sortDraft}
              onChange={(e) => setSortDraft(parseInt(e.target.value, 10) || 0)}
              min={0}
              disabled={labelSaving}
              placeholder="Sort order"
              style={{ maxWidth: 120 }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 6 }}>
          {!editingLabel ? (
            <>
              <button
                className="admin-btn admin-btn--small"
                onClick={() => {
                  setLabelDraft(template.label ?? '');
                  setSortDraft(template.sort_order);
                  setEditingLabel(true);
                }}
              >
                Изменить
              </button>
              <button
                className="admin-btn admin-btn--small admin-btn--danger"
                onClick={onDelete}
              >
                Удалить
              </button>
            </>
          ) : (
            <>
              <button
                className="admin-btn admin-btn--small admin-btn--primary"
                onClick={saveLabel}
                disabled={labelSaving}
              >
                {labelSaving ? '…' : 'OK'}
              </button>
              <button
                className="admin-btn admin-btn--small admin-btn--ghost"
                onClick={() => setEditingLabel(false)}
                disabled={labelSaving}
              >
                Отмена
              </button>
            </>
          )}
        </div>
      </div>

      {labelError && <div className="admin-error-banner">{labelError}</div>}
      {segError && <div className="admin-error-banner">{segError}</div>}

      {/* Превью текста — собранное из сегментов */}
      {sortedSegments.length > 0 && (
        <div
          style={{
            background: '#161719',
            border: '1px dashed #2a2c30',
            borderRadius: 4,
            padding: '10px 12px',
            marginBottom: 12,
            fontSize: '0.88rem',
            color: '#8c8f95',
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}
        >
          {sortedSegments.map((s, i) => (
            <React.Fragment key={s.id}>
              {s.kind === 'placeholder' ? (
                <span
                  style={{
                    background: 'rgba(212, 160, 70, 0.15)',
                    color: '#d4a046',
                    padding: '1px 6px',
                    borderRadius: 3,
                    fontFamily: 'monospace',
                    fontSize: '0.82rem',
                  }}
                >
                  {`{${s.placeholder_key}}`}
                </span>
              ) : (
                <span style={{ color: '#a4b8e4' }}>♪audio</span>
              )}
              <span style={{ color: '#e8e8ea' }}>{s.text_fragment}</span>
              {i < sortedSegments.length - 1 && ' '}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Сегменты */}
      <div className="admin-stack" style={{ marginBottom: addingSegment ? 16 : 8 }}>
        {sortedSegments.map((seg) =>
          editingSegmentId === seg.id ? (
            <SegmentEditor
              key={seg.id}
              mode="edit"
              segment={seg}
              audioFiles={audioFiles}
              placeholders={placeholders}
              onSaved={async () => {
                setEditingSegmentId(null);
                await onChanged();
              }}
              onCancel={() => setEditingSegmentId(null)}
            />
          ) : (
            <SegmentRow
              key={seg.id}
              segment={seg}
              busy={busySegId === seg.id}
              onEdit={() => setEditingSegmentId(seg.id)}
              onDelete={() => handleDeleteSegment(seg)}
            />
          ),
        )}
      </div>

      {addingSegment && (
        <SegmentEditor
          mode="create"
          templateId={template.id}
          defaultPosition={nextPosition}
          audioFiles={audioFiles}
          placeholders={placeholders}
          onSaved={async () => {
            setAddingSegment(false);
            await onChanged();
          }}
          onCancel={() => setAddingSegment(false)}
        />
      )}

      {!addingSegment && (
        <button
          className="admin-btn admin-btn--small"
          onClick={() => setAddingSegment(true)}
        >
          + Добавить сегмент
        </button>
      )}
    </div>
  );
}

function SegmentRow({
  segment,
  busy,
  onEdit,
  onDelete,
}: {
  segment: CompositeSegment;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        background: '#161719',
        border: '1px solid #2a2c30',
        borderRadius: 4,
        padding: 12,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
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
            #{segment.position}
          </span>
          <span className={`admin-pill admin-pill--${segment.kind}`}>{segment.kind}</span>
          {segment.kind === 'audio' && segment.audio_url && (
            <AudioPlayer url={segment.audio_url} size="small" />
          )}
          {segment.kind === 'placeholder' && (
            <code
              style={{
                background: 'rgba(212, 160, 70, 0.12)',
                color: '#d4a046',
                padding: '2px 8px',
                borderRadius: 3,
                fontSize: '0.82rem',
              }}
            >
              {`{${segment.placeholder_key}}`}
            </code>
          )}
        </div>
        {segment.text_fragment && (
          <div style={{ fontSize: '0.88rem', color: '#e8e8ea', lineHeight: 1.5 }}>
            {segment.text_fragment}
          </div>
        )}
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
  );
}
