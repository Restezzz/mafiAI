import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  adminStoriesApi,
  StoryListItem,
} from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';


/**
 * Список сюжетов. Каждый сюжет — карточка с краткой инфо и кнопками:
 * - "Открыть" → переход в редактор графа (этап 4.2, пока заглушка).
 * - "Дублировать" → POST /duplicate, копия открывается в редакторе.
 * - "Экспорт" → GET /export, скачивает JSON-снапшот.
 * - "Удалить" → confirm + DELETE.
 *
 * Импорт — отдельная форма наверху: file-picker + кнопка "Импортировать JSON".
 *
 * Создание нового сюжета — простая форма (slug + name + description).
 * Полноценный редактор графа на @xyflow/react — в этапе 4.2.
 */
export default function AdminStoriesListPage() {
  const navigate = useNavigate();

  const [stories, setStories] = useState<StoryListItem[]>([]);
  const [includeObsolete, setIncludeObsolete] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create form.
  const [createOpen, setCreateOpen] = useState(false);
  const [createSlug, setCreateSlug] = useState('');
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  // Import form.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importSuccess, setImportSuccess] = useState('');

  // Per-row busy state for duplicate/delete/export.
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadList = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminStoriesApi.list({
        include_obsolete: includeObsolete,
        include_inactive: includeInactive,
      });
      setStories(res.data.stories);
    } catch (err) {
      logger.warn('admin.stories.load_failed', 'Failed to load stories', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось загрузить сюжеты');
    } finally {
      setLoading(false);
    }
  }, [includeObsolete, includeInactive]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    const slug = createSlug.trim();
    const name = createName.trim();
    if (!slug || !name) {
      setCreateError('Slug и название обязательны');
      return;
    }
    setCreateBusy(true);
    try {
      const res = await adminStoriesApi.create({
        slug,
        name,
        description: createDescription.trim() || undefined,
      });
      setCreateOpen(false);
      setCreateSlug('');
      setCreateName('');
      setCreateDescription('');
      // Сразу открываем редактор для нового сюжета (этап 4.2).
      navigate(`/admin/stories/${res.data.id}`);
    } catch (err) {
      logger.warn('admin.stories.create_failed', 'Failed to create story', {
        error: parseApiError(err),
      });
      setCreateError(getApiErrorMessage(err) ?? 'Не удалось создать сюжет');
    } finally {
      setCreateBusy(false);
    }
  };

  const handleDuplicate = async (story: StoryListItem) => {
    setBusyId(story.id);
    try {
      const res = await adminStoriesApi.duplicate(story.id);
      await loadList();
      navigate(`/admin/stories/${res.data.id}`);
    } catch (err) {
      logger.warn('admin.stories.duplicate_failed', 'Failed to duplicate story', {
        error: parseApiError(err),
        storyId: story.id,
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось продублировать сюжет');
    } finally {
      setBusyId(null);
    }
  };

  const handleExport = async (story: StoryListItem) => {
    setBusyId(story.id);
    try {
      const res = await adminStoriesApi.export(story.id);
      // Скачиваем JSON: создаём Blob, dummy <a download>, click(), revoke.
      const json = JSON.stringify(res.data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `story_${story.slug}_v${story.version}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.warn('admin.stories.export_failed', 'Failed to export story', {
        error: parseApiError(err),
        storyId: story.id,
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось экспортировать сюжет');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (story: StoryListItem) => {
    const confirmed = window.confirm(
      `Удалить сюжет «${story.name}» (v${story.version})?\n\n` +
        `Все шаги, переходы, фразы и настройки будут удалены безвозвратно.\n` +
        `Активные сессии на этой версии продолжат играть на снимке (этап 2),\n` +
        `но в этапе 1 — без проверки. Будьте аккуратны.`,
    );
    if (!confirmed) return;
    setBusyId(story.id);
    try {
      await adminStoriesApi.delete(story.id);
      await loadList();
    } catch (err) {
      logger.warn('admin.stories.delete_failed', 'Failed to delete story', {
        error: parseApiError(err),
        storyId: story.id,
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить сюжет');
    } finally {
      setBusyId(null);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportError('');
    setImportSuccess('');
    const file = e.target.files?.[0];
    if (!file) return;
    setImportBusy(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await adminStoriesApi.import(payload);
      setImportSuccess(`Импортирован сюжет «${res.data.name}»`);
      await loadList();
    } catch (err) {
      logger.warn('admin.stories.import_failed', 'Failed to import story', {
        error: parseApiError(err),
      });
      const msg =
        getApiErrorMessage(err) ??
        (err instanceof SyntaxError ? 'JSON-файл повреждён или невалиден' : 'Не удалось импортировать');
      setImportError(msg);
    } finally {
      setImportBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Сюжеты</h1>
          <p className="admin-page-header__subtitle">
            Настраиваемые сценарии игры: порядок ходов, фразы ведущего, ветвления.
            Поддерживается версионирование (при изменении активной версии создаётся
            новая, старая остаётся для уже идущих сессий).
          </p>
        </div>
        <div className="admin-page-header__actions">
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={() => setCreateOpen((v) => !v)}
          >
            {createOpen ? 'Отмена' : '+ Создать сюжет'}
          </button>
        </div>
      </header>

      <div className="admin-stack">
        {error && <div className="admin-error-banner">{error}</div>}

        {/* Импорт из JSON */}
        <div className="admin-card">
          <h3 style={{ marginTop: 0, marginBottom: 12 }}>Импорт сюжета из JSON</h3>
          <p className="admin-row__hint" style={{ marginBottom: 12 }}>
            Загрузите файл, экспортированный кнопкой «Экспорт». Все слаги триггеров
            будут резолвиться через текущую narrator-БД; пропавшие останутся
            text-only.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleImport}
            disabled={importBusy}
          />
          {importBusy && <span style={{ marginLeft: 12 }}>Импортируем…</span>}
          {importError && (
            <div className="admin-error-banner" style={{ marginTop: 12 }}>
              {importError}
            </div>
          )}
          {importSuccess && (
            <div className="admin-success-banner" style={{ marginTop: 12 }}>
              {importSuccess}
            </div>
          )}
        </div>

        {/* Создание нового сюжета */}
        {createOpen && (
          <div className="admin-card">
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>Новый сюжет</h3>
            <form onSubmit={handleCreate} className="admin-stack">
              <div>
                <label htmlFor="story-slug" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
                  Slug (a-z0-9_)
                </label>
                <input
                  id="story-slug"
                  className="admin-input"
                  placeholder="my_custom_mafia"
                  value={createSlug}
                  onChange={(e) => setCreateSlug(e.target.value)}
                  disabled={createBusy}
                />
              </div>
              <div>
                <label htmlFor="story-name" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
                  Название
                </label>
                <input
                  id="story-name"
                  className="admin-input"
                  placeholder="Моя кастомная мафия"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  disabled={createBusy}
                />
              </div>
              <div>
                <label htmlFor="story-desc" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
                  Описание (опц.)
                </label>
                <textarea
                  id="story-desc"
                  className="admin-input"
                  rows={3}
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  disabled={createBusy}
                />
              </div>
              {createError && (
                <div className="admin-error-banner">{createError}</div>
              )}
              <div className="admin-row">
                <button type="submit" className="admin-btn admin-btn--primary" disabled={createBusy}>
                  {createBusy ? 'Создаём…' : 'Создать'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Фильтры */}
        <div className="admin-card">
          <div className="admin-row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <label className="admin-row__hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
              />
              Показывать старые версии
            </label>
            <label className="admin-row__hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={includeObsolete}
                onChange={(e) => setIncludeObsolete(e.target.checked)}
              />
              Показывать архивированные
            </label>
          </div>
        </div>

        {/* Список сюжетов */}
        <div className="admin-card">
          {loading ? (
            <div>Загружаем…</div>
          ) : stories.length === 0 ? (
            <div className="admin-row__hint">
              Сюжетов пока нет. Создайте первый — или нажмите «Импорт» для
              восстановления из JSON.
            </div>
          ) : (
            <div className="admin-users-list">
              {stories.map((story) => (
                <div key={story.id} className="admin-users-list__row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{story.name}</strong>
                      <span className="admin-row__hint">
                        {story.slug} v{story.version}
                      </span>
                      {story.is_active && (
                        <span
                          style={{
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: '#2d6a4f',
                            color: '#fff',
                          }}
                        >
                          активна
                        </span>
                      )}
                      {story.is_obsolete && (
                        <span
                          style={{
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: '#6c757d',
                            color: '#fff',
                          }}
                        >
                          архив
                        </span>
                      )}
                    </div>
                    {story.description && (
                      <div className="admin-row__hint" style={{ marginTop: 4 }}>
                        {story.description}
                      </div>
                    )}
                    <div className="admin-row__hint" style={{ marginTop: 4 }}>
                      Шагов: {story.steps_count}
                      {story.active_sessions_count > 0 &&
                        ` · Активных сессий: ${story.active_sessions_count}`}
                    </div>
                  </div>
                  <div className="admin-row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="admin-btn admin-btn--primary"
                      onClick={() => navigate(`/admin/stories/${story.id}`)}
                      disabled={busyId === story.id}
                    >
                      Открыть
                    </button>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => handleDuplicate(story)}
                      disabled={busyId === story.id}
                    >
                      Дубль
                    </button>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => handleExport(story)}
                      disabled={busyId === story.id}
                    >
                      Экспорт
                    </button>
                    <button
                      type="button"
                      className="admin-btn"
                      style={{ color: '#dc3545', borderColor: '#dc3545' }}
                      onClick={() => handleDelete(story)}
                      disabled={busyId === story.id || story.active_sessions_count > 0}
                      title={
                        story.active_sessions_count > 0
                          ? 'Нельзя удалить: есть активные сессии'
                          : undefined
                      }
                    >
                      Удалить
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
