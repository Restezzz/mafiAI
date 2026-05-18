import React, { useEffect, useMemo, useRef, useState } from 'react';
import { adminNarratorApi } from '../../api/adminNarratorApi';
import { AudioFile } from '../../types/narrator';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import AudioPlayer from '../../components/admin/AudioPlayer';

const MAX_BYTES = 10 * 1024 * 1024;

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

export default function AudioLibraryPage() {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  const loadFiles = async () => {
    try {
      const { data } = await adminNarratorApi.listAudioFiles();
      setFiles(data.audio_files);
    } catch (err) {
      logger.warn('admin.audio.list_failed', 'Failed to load audio files', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось загрузить аудио-файлы');
    }
  };

  useEffect(() => {
    let cancelled = false;
    loadFiles().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files
      .filter((f) => !q || f.filename.toLowerCase().includes(q))
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }, [files, query]);

  const totalSize = files.reduce((acc, f) => acc + f.size_bytes, 0);
  const totalDuration = files.reduce((acc, f) => acc + f.duration_ms, 0);

  const handleSelectFile = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setUploadError(`Размер mp3 превышает ${MAX_BYTES / (1024 * 1024)} MB`);
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const { data } = await adminNarratorApi.uploadAudioFile(file);
      setFiles((prev) => [...prev, data].sort((a, b) => a.filename.localeCompare(b.filename)));
      logger.info('admin.audio.uploaded', 'Audio uploaded via admin UI', {
        audioId: data.id,
        filename: data.filename,
      });
    } catch (err) {
      logger.warn('admin.audio.upload_failed', 'Failed to upload audio', {
        error: parseApiError(err),
      });
      setUploadError(getApiErrorMessage(err) ?? 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (file: AudioFile) => {
    if (
      !window.confirm(
        `Удалить «${file.filename}»?\n\n` +
          `Если на него ссылаются варианты или сегменты — они станут text-only.\n` +
          `Если на него ссылается имя игрока — удаление будет отклонено.`,
      )
    ) {
      return;
    }
    setBusyId(file.id);
    setError('');
    try {
      await adminNarratorApi.deleteAudioFile(file.id);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (err) {
      logger.warn('admin.audio.delete_failed', 'Failed to delete audio', {
        error: parseApiError(err),
      });
      setError(getApiErrorMessage(err) ?? 'Не удалось удалить файл');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <header className="admin-page-header">
        <div className="admin-page-header__titles">
          <h1 className="admin-page-header__title">Аудиотека</h1>
          <p className="admin-page-header__subtitle">
            mp3-файлы для вариантов триггеров и сегментов composite-шаблонов.
            Загруженные файлы можно сразу выбирать в редакторах вариантов и сегментов.
          </p>
        </div>
        <div className="admin-page-header__actions">
          <button
            className="admin-btn admin-btn--primary"
            onClick={handleSelectFile}
            disabled={uploading}
          >
            {uploading ? 'Загрузка…' : '+ Загрузить mp3'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/mpeg,audio/mp3,.mp3"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
        </div>
      </header>

      {error && <div className="admin-error-banner">{error}</div>}
      {uploadError && <div className="admin-error-banner">{uploadError}</div>}

      {/* Сводка */}
      <div className="admin-card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="admin-row" style={{ fontSize: '0.85rem' }}>
          <span>
            <strong>{files.length}</strong> файл
            {files.length === 1 ? '' : files.length < 5 ? 'а' : 'ов'}
          </span>
          <span style={{ color: '#8c8f95' }}>•</span>
          <span style={{ color: '#8c8f95' }}>
            {formatBytes(totalSize)} суммарно
          </span>
          <span style={{ color: '#8c8f95' }}>•</span>
          <span style={{ color: '#8c8f95' }}>
            {(totalDuration / 1000).toFixed(0)} сек звука
          </span>
        </div>
      </div>

      <div className="admin-card" style={{ padding: 14, marginBottom: 16 }}>
        <input
          className="admin-input"
          placeholder="Поиск по имени файла…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && <div className="admin-loading">Загрузка библиотеки…</div>}

      {!loading && filtered.length === 0 && (
        <div className="admin-empty">
          <div className="admin-empty__title">Файлов не найдено</div>
          <div>{query ? 'Попробуйте изменить поиск.' : 'Загрузите первый mp3.'}</div>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="admin-stack">
          {filtered.map((f) => (
            <div
              key={f.id}
              className="admin-card"
              style={{
                margin: 0,
                padding: 14,
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 240 }}>
                <div
                  style={{
                    fontWeight: 500,
                    marginBottom: 4,
                    wordBreak: 'break-all',
                  }}
                >
                  {f.filename}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#8c8f95' }}>
                  {(f.duration_ms / 1000).toFixed(1)}s • {formatBytes(f.size_bytes)} •{' '}
                  загружен {new Date(f.uploaded_at).toLocaleDateString()}
                </div>
              </div>
              <AudioPlayer url={f.url} size="small" />
              <button
                className="admin-btn admin-btn--small admin-btn--danger"
                onClick={() => handleDelete(f)}
                disabled={busyId === f.id}
              >
                {busyId === f.id ? '…' : 'Удалить'}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
