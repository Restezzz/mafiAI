/**
 * Панель ноды «Роли» (фича 2).
 *
 * Позволяет переопределить визуал ролей для конкретного сюжета: новое
 * отображаемое имя + две карточки-картинки (front/back) для стадии выдачи
 * роли. Логика ролей не меняется — только их название и картинки.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Upload, X } from 'lucide-react';
import {
  adminStoriesApi,
  RoleCatalogItem,
  StoryReadFull,
  StoryRoleOverride,
} from '../../../api/adminStoriesApi';
import { logger } from '../../../services/logger';
import { parseApiError } from '../../../utils/parseApiError';
import { API_BASE_URL } from '../../../utils/constants';

interface Props {
  storyId: string;
  story: StoryReadFull;
  onStoryChanged: () => void;
}

function CardSlot({
  label,
  url,
  uploading,
  onUpload,
  onClear,
}: {
  label: string;
  url: string | null;
  uploading: boolean;
  onUpload: (file: File) => void;
  onClear: () => void;
}) {
  return (
    <div className="roles-node-panel__card">
      <span className="roles-node-panel__card-label">{label}</span>
      {url ? (
        <div className="roles-node-panel__card-preview">
          <img src={`${API_BASE_URL}${url}`} alt={label} />
          <button
            type="button"
            className="step-edit-panel__cue-delete"
            onClick={onClear}
            title="Убрать картинку"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <div className="roles-node-panel__card-empty">нет картинки</div>
      )}
      <label className="step-edit-panel__upload-label">
        <Upload size={12} />
        <span>{url ? 'Заменить' : 'Загрузить'}</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
          }}
          disabled={uploading}
          style={{ display: 'none' }}
        />
      </label>
    </div>
  );
}

export default function RolesNodePanel({ storyId, story, onStoryChanged }: Props) {
  const [roles, setRoles] = useState<RoleCatalogItem[]>([]);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminStoriesApi
      .listRoles()
      .then((res) => setRoles(res.data.roles))
      .catch((err) =>
        logger.warn('admin.story.roles_list_failed', 'roles list failed', {
          error: parseApiError(err),
        }),
      );
  }, []);

  const overrideBySlug = useMemo(
    () => new Map<string, StoryRoleOverride>(story.role_overrides.map((o) => [o.role_slug, o])),
    [story.role_overrides],
  );

  const ensureOverride = useCallback(
    async (roleSlug: string): Promise<StoryRoleOverride> => {
      const existing = overrideBySlug.get(roleSlug);
      if (existing) return existing;
      const res = await adminStoriesApi.createRoleOverride(storyId, {
        role_slug: roleSlug,
      });
      return res.data;
    },
    [storyId, overrideBySlug],
  );

  const handleName = useCallback(
    async (roleSlug: string, name: string) => {
      try {
        const ov = await ensureOverride(roleSlug);
        const trimmed = name.trim();
        await adminStoriesApi.updateRoleOverride(storyId, ov.id, trimmed
          ? { display_name: trimmed }
          : { unset_display_name: true });
        onStoryChanged();
      } catch (err) {
        setError('Не удалось сохранить имя');
        logger.warn('admin.story.role_override_name_failed', 'name failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, ensureOverride, onStoryChanged],
  );

  const handleDescription = useCallback(
    async (roleSlug: string, description: string) => {
      try {
        const ov = await ensureOverride(roleSlug);
        const trimmed = description.trim();
        await adminStoriesApi.updateRoleOverride(storyId, ov.id, trimmed
          ? { description: trimmed }
          : { unset_description: true });
        onStoryChanged();
      } catch (err) {
        setError('Не удалось сохранить описание');
        logger.warn('admin.story.role_override_desc_failed', 'desc failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, ensureOverride, onStoryChanged],
  );

  const handleCard = useCallback(
    async (roleSlug: string, side: 'front' | 'back', file: File | null) => {
      setBusySlug(roleSlug);
      setError(null);
      try {
        const ov = await ensureOverride(roleSlug);
        let imageId: string | null = null;
        if (file) {
          const up = await adminStoriesApi.uploadImage(file);
          imageId = up.data.id;
        }
        const payload =
          side === 'front'
            ? file
              ? { card_front_image_id: imageId }
              : { unset_card_front: true }
            : file
              ? { card_back_image_id: imageId }
              : { unset_card_back: true };
        await adminStoriesApi.updateRoleOverride(storyId, ov.id, payload);
        onStoryChanged();
      } catch (err) {
        setError('Не удалось сохранить картинку');
        logger.warn('admin.story.role_override_card_failed', 'card failed', {
          error: parseApiError(err),
        });
      } finally {
        setBusySlug(null);
      }
    },
    [storyId, ensureOverride, onStoryChanged],
  );

  const handleReset = useCallback(
    async (roleSlug: string) => {
      const ov = overrideBySlug.get(roleSlug);
      if (!ov) return;
      try {
        await adminStoriesApi.deleteRoleOverride(storyId, ov.id);
        onStoryChanged();
      } catch (err) {
        logger.warn('admin.story.role_override_delete_failed', 'delete failed', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, overrideBySlug, onStoryChanged],
  );

  return (
    <div className="step-edit-panel__section roles-node-panel">
      <div className="step-edit-panel__section-header">
        <span>Переопределение ролей</span>
      </div>
      {error && <div className="step-edit-panel__error">{error}</div>}
      {roles.length === 0 && (
        <div className="step-edit-panel__empty">Справочник ролей пуст.</div>
      )}
      {roles.map((role) => {
        const ov = overrideBySlug.get(role.slug);
        return (
          <RoleRow
            key={role.slug}
            role={role}
            override={ov}
            busy={busySlug === role.slug}
            onName={(name) => handleName(role.slug, name)}
            onDescription={(desc) => handleDescription(role.slug, desc)}
            onCard={(side, file) => handleCard(role.slug, side, file)}
            onReset={() => handleReset(role.slug)}
          />
        );
      })}
    </div>
  );
}

function RoleRow({
  role,
  override,
  busy,
  onName,
  onDescription,
  onCard,
  onReset,
}: {
  role: RoleCatalogItem;
  override?: StoryRoleOverride;
  busy: boolean;
  onName: (name: string) => void;
  onDescription: (description: string) => void;
  onCard: (side: 'front' | 'back', file: File | null) => void;
  onReset: () => void;
}) {
  const [name, setName] = useState(override?.display_name ?? '');
  useEffect(() => {
    setName(override?.display_name ?? '');
  }, [override?.display_name]);
  const [description, setDescription] = useState(override?.description ?? '');
  useEffect(() => {
    setDescription(override?.description ?? '');
  }, [override?.description]);

  return (
    <div className="roles-node-panel__role">
      <div className="roles-node-panel__role-header">
        <span className="roles-node-panel__role-base">
          {role.name} <code>{role.slug}</code>
        </span>
        {override && (
          <button
            type="button"
            className="step-edit-panel__cue-delete"
            onClick={onReset}
            title="Сбросить переопределение"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <input
        className="admin-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if ((override?.display_name ?? '') !== name) onName(name);
        }}
        placeholder="Новое имя роли (необязательно)"
      />
      <textarea
        className="admin-input roles-node-panel__desc"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => {
          if ((override?.description ?? '') !== description) onDescription(description);
        }}
        placeholder="Описание роли (заменяет дефолтное; необязательно)"
        rows={3}
      />
      <div className="roles-node-panel__cards">
        <CardSlot
          label="Лицо карты"
          url={override?.card_front_url ?? null}
          uploading={busy}
          onUpload={(f) => onCard('front', f)}
          onClear={() => onCard('front', null)}
        />
        <CardSlot
          label="Рубашка"
          url={override?.card_back_url ?? null}
          uploading={busy}
          onUpload={(f) => onCard('back', f)}
          onClear={() => onCard('back', null)}
        />
      </div>
    </div>
  );
}
