/**
 * Inline-форма быстрого создания триггера прямо из редактора сюжета (этап 6.6).
 *
 * Что делает за один клик:
 *  1. POST /admin/narrator/triggers  — создаёт триггер `kind='variant'` с
 *     указанным `story_id` (всегда story-scoped, никогда не global; для
 *     создания global нужна полная страница /admin/triggers/create).
 *  2. Если выбран mp3-файл — POST /admin/narrator/audio-files (multipart):
 *     заливает аудио, получает audio_file_id.
 *  3. POST /admin/narrator/triggers/{id}/variants — создаёт один variant
 *     с текстом + опционально audio_file_id из шага 2.
 *  4. GET /admin/narrator/triggers/{id} — забирает свежий триггер целиком
 *     (с variants + audio_url), отдаёт parent'у через onCreated.
 *
 * Сложные сценарии (несколько variants, composite, name-assets) остались в
 * полноценной странице /admin/triggers/{id} — туда ведёт ссылка "открыть в
 * полном редакторе".
 *
 * Composite-триггеры намеренно НЕ поддерживаются inline: сегменты + placeholder'ы
 * нельзя нормально упаковать в одну форму без UX-перегруза.
 */
import React, { useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { Trigger } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';

interface Props {
  storyId: string;
  /** Префиксное предложение для group_key, если у пользователя нет идей. */
  defaultGroupKey?: string;
  onCreated: (trigger: Trigger) => void;
  onCancel: () => void;
}

const _SLUG_RE = /^[a-z0-9_]{1,80}$/;
const _GROUP_KEY_RE = /^[a-z0-9_]{1,50}$/;

export default function InlineTriggerCreator({
  storyId,
  defaultGroupKey = 'story_custom',
  onCreated,
  onCancel,
}: Props) {
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [groupKey, setGroupKey] = useState(defaultGroupKey);
  const [text, setText] = useState('');
  const [mp3File, setMp3File] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const slugValid = _SLUG_RE.test(slug);
  const groupKeyValid = _GROUP_KEY_RE.test(groupKey);
  const labelValid = label.trim().length > 0 && label.length <= 120;
  const textValid = text.trim().length > 0 && text.length <= 4000;
  const formValid = slugValid && groupKeyValid && labelValid && textValid;

  const submit = async () => {
    if (!formValid) return;
    setSubmitting(true);
    setError('');
    try {
      // 1. Создаём триггер (story-scoped).
      const triggerRes = await adminNarratorApi.createTrigger({
        slug,
        story_id: storyId,
        group_key: groupKey,
        label,
        kind: 'variant',
      });
      const triggerId = triggerRes.data.id;

      // 2. Аудио (опционально).
      let audioFileId: string | undefined;
      if (mp3File) {
        try {
          const audioRes = await adminNarratorApi.uploadAudioFile(mp3File);
          audioFileId = audioRes.data.id;
        } catch (audioErr) {
          // Аудио опционально — но если оно есть и упало, лучше остановиться
          // и сказать пользователю. Триггер при этом уже создан, но без variant —
          // он будет виден в списке как «пустой», и его можно дописать вручную.
          const msg = getApiErrorMessage(audioErr) ?? 'Не удалось загрузить mp3';
          setError(`Триггер создан, но загрузка mp3 не удалась: ${msg}`);
          logger.warn('admin.inline_trigger.audio_upload_failed',
            'Inline trigger: mp3 upload failed',
            { error: parseApiError(audioErr), triggerId });
          return;
        }
      }

      // 3. Создаём один variant.
      await adminNarratorApi.createVariant(triggerId, {
        text,
        audio_file_id: audioFileId,
        sort_order: 0,
      });

      // 4. Подтягиваем триггер целиком (с variants/audio_url).
      const fullRes = await adminNarratorApi.getTrigger(triggerId);
      onCreated(fullRes.data);
    } catch (err) {
      const msg = getApiErrorMessage(err) ?? 'Не удалось создать триггер';
      setError(msg);
      logger.warn('admin.inline_trigger.create_failed', msg, {
        error: parseApiError(err), storyId,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="inline-trigger-creator-title"
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onCancel(); }}
    >
      <div style={{
        background: '#16181d', border: '1px solid #2a2d33', borderRadius: 8,
        padding: 20, width: '100%', maxWidth: 520,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <h3 id="inline-trigger-creator-title" style={{ margin: 0 }}>
          Новый триггер сюжета
        </h3>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>
          Создаётся как story-scoped. Будет виден только в этом сюжете и
          удалится вместе с ним. Для общих (global) триггеров используйте
          полную страницу <code>/admin/triggers</code>.
        </p>

        {error && (
          <div className="admin-error-banner" style={{ fontSize: 12 }}>
            {error}
          </div>
        )}

        <Field label="slug" hint="[a-z0-9_], 1..80 символов">
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my_story_intro"
            disabled={submitting}
            style={fieldInputStyle(slugValid || slug === '')}
          />
        </Field>

        <Field label="label" hint="Человеко-читаемое название">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Вступление мафии"
            disabled={submitting}
            style={fieldInputStyle(labelValid || label === '')}
          />
        </Field>

        <Field label="group_key" hint="UI-группа в админке (intro, night_mafia, ...)">
          <input
            type="text"
            value={groupKey}
            onChange={(e) => setGroupKey(e.target.value)}
            disabled={submitting}
            style={fieldInputStyle(groupKeyValid || groupKey === '')}
          />
        </Field>

        <Field label="text" hint="То что произносит narrator. Можно использовать {player_name} и другие placeholder'ы.">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Город засыпает. Просыпается мафия…"
            rows={3}
            disabled={submitting}
            style={{
              ...fieldInputStyle(textValid || text === ''),
              fontFamily: 'inherit', resize: 'vertical',
            }}
          />
        </Field>

        <Field label="mp3" hint="Опционально. Без файла будет работать typewriter без озвучки.">
          <input
            type="file"
            accept="audio/mpeg,.mp3"
            onChange={(e) => setMp3File(e.target.files?.[0] ?? null)}
            disabled={submitting}
            style={{ fontSize: 12 }}
          />
          {mp3File && (
            <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 8 }}>
              {mp3File.name} ({Math.round(mp3File.size / 1024)} КБ)
            </span>
          )}
        </Field>

        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6,
        }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="admin-btn"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!formValid || submitting}
            className="admin-btn admin-btn--primary"
            style={{ opacity: !formValid || submitting ? 0.5 : 1 }}
          >
            {submitting ? 'Создаём…' : 'Создать триггер'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
      {hint && <span style={{ fontSize: 11, opacity: 0.55 }}>{hint}</span>}
      {children}
    </label>
  );
}

function fieldInputStyle(valid: boolean): React.CSSProperties {
  return {
    padding: '6px 8px',
    background: '#0a0b0e',
    border: `1px solid ${valid ? '#2a2d33' : '#7a3a3a'}`,
    borderRadius: 4,
    color: '#e8e9eb',
    fontSize: 13,
  };
}
