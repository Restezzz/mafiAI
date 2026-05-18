import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { Trigger } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import AudioPlayer from '../../components/admin/AudioPlayer';
import TriggerVariantsSection from '../../components/admin/TriggerVariantsSection';
import TriggerCompositeSection from '../../components/admin/TriggerCompositeSection';

export default function TriggerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Inline edit state for label/group_key/description
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [groupDraft, setGroupDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await adminNarratorApi.getTrigger(id);
      setTrigger(data);
    } catch (err) {
      logger.warn('admin.trigger.load_failed', 'Failed to load trigger', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось загрузить триггер');
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const startEdit = () => {
    if (!trigger) return;
    setLabelDraft(trigger.label);
    setGroupDraft(trigger.group_key);
    setDescDraft(trigger.description ?? '');
    setSaveError('');
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!trigger) return;
    setSaving(true);
    setSaveError('');
    try {
      const { data } = await adminNarratorApi.updateTrigger(trigger.id, {
        label: labelDraft.trim(),
        group_key: groupDraft.trim(),
        description: descDraft.trim() || null,
      });
      setTrigger(data);
      setEditing(false);
    } catch (err) {
      logger.warn('admin.trigger.update_failed', 'Failed to update trigger', {
        error: parseApiError(err),
      });
      setSaveError(getApiErrorMessage(err) ?? 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!trigger) return;
    const confirm = window.confirm(
      `Удалить триггер "${trigger.label}" (${trigger.slug})?\n\n` +
        `Все его варианты и шаблоны тоже будут удалены. Операция необратима.`,
    );
    if (!confirm) return;
    setDeleting(true);
    try {
      await adminNarratorApi.deleteTrigger(trigger.id);
      logger.info('admin.trigger.deleted', 'Trigger deleted via admin UI', {
        triggerId: trigger.id,
        slug: trigger.slug,
      });
      navigate('/admin/triggers');
    } catch (err) {
      logger.warn('admin.trigger.delete_failed', 'Failed to delete trigger', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить');
      setDeleting(false);
    }
  };

  if (loading) return <div className="admin-loading">Загрузка триггера…</div>;

  if (error && !trigger) {
    return (
      <>
        <div className="admin-error-banner">{error}</div>
        <Link to="/admin/triggers" className="admin-btn">
          ← К списку
        </Link>
      </>
    );
  }

  if (!trigger) return null;

  return (
    <>
      <Link
        to="/admin/triggers"
        style={{
          display: 'inline-block',
          marginBottom: 16,
          color: '#8c8f95',
          textDecoration: 'none',
          fontSize: '0.85rem',
        }}
      >
        ← К списку триггеров
      </Link>

      {error && <div className="admin-error-banner">{error}</div>}

      <div className="admin-card">
        {!editing && (
          <>
            <div
              style={{
                display: 'flex',
                gap: 12,
                marginBottom: 12,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <span className={`admin-pill admin-pill--${trigger.kind}`}>
                {trigger.kind}
              </span>
              <span className="admin-pill">{trigger.group_key}</span>
              <code
                style={{
                  fontSize: '0.85rem',
                  color: '#8c8f95',
                  background: '#0d0e10',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                {trigger.slug}
              </code>
            </div>
            <h1 style={{ margin: '0 0 8px', fontSize: '1.5rem', fontWeight: 600 }}>
              {trigger.label}
            </h1>
            {trigger.description && (
              <p style={{ margin: '0 0 12px', color: '#8c8f95', fontSize: '0.92rem' }}>
                {trigger.description}
              </p>
            )}
            <div style={{ fontSize: '0.78rem', color: '#8c8f95' }}>
              Создан: {new Date(trigger.created_at).toLocaleString()} • Обновлён:{' '}
              {new Date(trigger.updated_at).toLocaleString()}
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="admin-btn" onClick={startEdit}>
                Редактировать
              </button>
              <button
                className="admin-btn admin-btn--danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? 'Удаление…' : 'Удалить триггер'}
              </button>
            </div>
          </>
        )}

        {editing && (
          <div>
            <h2 style={{ margin: '0 0 16px', fontSize: '1.15rem' }}>
              Редактирование триггера
            </h2>
            <div className="admin-field">
              <label className="admin-field__label">Label (отображаемое название)</label>
              <input
                className="admin-input"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                disabled={saving}
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label">Group key</label>
              <input
                className="admin-input"
                value={groupDraft}
                onChange={(e) => setGroupDraft(e.target.value)}
                disabled={saving}
              />
              <div className="admin-field__hint">
                [a-z0-9_], используется для группировки в UI.
              </div>
            </div>
            <div className="admin-field">
              <label className="admin-field__label">Описание</label>
              <textarea
                className="admin-textarea"
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                disabled={saving}
                rows={3}
              />
            </div>
            <div className="admin-field">
              <label className="admin-field__label">Slug и kind (неизменяемы)</label>
              <div
                style={{
                  fontSize: '0.82rem',
                  color: '#8c8f95',
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span>
                  slug: <code>{trigger.slug}</code>
                </span>
                <span>kind: {trigger.kind}</span>
              </div>
              <div className="admin-field__hint">
                Для смены slug или kind необходимо создать новый триггер и переключить
                game_engine.
              </div>
            </div>

            {saveError && <div className="admin-error-banner">{saveError}</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="admin-btn admin-btn--primary"
                onClick={saveEdit}
                disabled={saving}
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button
                className="admin-btn admin-btn--ghost"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>

      {trigger.kind === 'variant' && (
        <TriggerVariantsSection trigger={trigger} onChanged={reload} />
      )}

      {trigger.kind === 'composite' && (
        <TriggerCompositeSection trigger={trigger} onChanged={reload} />
      )}
    </>
  );
}
