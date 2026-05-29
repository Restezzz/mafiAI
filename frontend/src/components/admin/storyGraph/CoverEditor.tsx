/**
 * Редактор обложки сюжета (фича 3): загрузка картинки + кадрирование под
 * рамку карточки голосования (соотношение 3:2). Crop хранится в долях
 * оригинала ({x,y,w,h} в [0..1]); h выводится из w так, чтобы вырезанная
 * область сохраняла 3:2 независимо от пропорций исходной картинки.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Upload, Trash2 } from 'lucide-react';
import { adminStoriesApi, CoverCrop } from '../../../api/adminStoriesApi';
import { API_BASE_URL } from '../../../utils/constants';
import { parseApiError } from '../../../utils/parseApiError';
import { logger } from '../../../services/logger';

const FRAME_ASPECT = 3 / 2; // width / height карточки сюжета

interface Props {
  coverUrl: string | null;
  crop: CoverCrop | null;
  imageWidth: number | null;
  imageHeight: number | null;
  onUploaded: (image: { id: string; url: string; width: number | null; height: number | null }) => void;
  onCropChange: (crop: CoverCrop) => void;
  onRemove: () => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export default function CoverEditor({
  coverUrl,
  crop,
  imageWidth,
  imageHeight,
  onUploaded,
  onCropChange,
  onRemove,
}: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Натуральные размеры считываем из самого <img> (onLoad) — props могут
  // быть null для уже сохранённой обложки.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(
    imageWidth && imageHeight ? { w: imageWidth, h: imageHeight } : null,
  );

  // Высота crop в долях, выводимая из ширины так, чтобы вырезанная область
  // имела соотношение FRAME_ASPECT. Если размеры картинки неизвестны —
  // используем квадратную картинку как приближение.
  const natW = natural?.w ?? imageWidth ?? 1;
  const natH = natural?.h ?? imageHeight ?? 1;
  const hFromW = useCallback(
    (w: number) => clamp((w * natW) / (FRAME_ASPECT * natH), 0.05, 1),
    [natW, natH],
  );

  const effective: CoverCrop = useMemo(
    () => crop ?? { x: 0, y: 0, w: 1, h: hFromW(1) },
    [crop, hFromW],
  );

  const handleFile = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        const res = await adminStoriesApi.uploadImage(file);
        onUploaded({
          id: res.data.id,
          url: res.data.url,
          width: res.data.width,
          height: res.data.height,
        });
        const w = 1;
        onCropChange({ x: 0, y: 0, w, h: hFromW(w) });
      } catch (err) {
        setError('Не удалось загрузить картинку');
        logger.warn('admin.story.cover_upload_failed', 'cover upload failed', {
          error: parseApiError(err),
        });
      } finally {
        setUploading(false);
      }
    },
    [onUploaded, onCropChange, hFromW],
  );

  const handleWidthChange = useCallback(
    (w: number) => {
      const h = hFromW(w);
      const x = clamp(effective.x, 0, 1 - w);
      const y = clamp(effective.y, 0, 1 - h);
      onCropChange({ x, y, w, h });
    },
    [effective.x, effective.y, hFromW, onCropChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: effective.x,
        origY: effective.y,
      };
    },
    [effective.x, effective.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      const frame = frameRef.current;
      if (!drag || !frame) return;
      const rect = frame.getBoundingClientRect();
      const dx = (e.clientX - drag.startX) / rect.width;
      const dy = (e.clientY - drag.startY) / rect.height;
      const x = clamp(drag.origX + dx, 0, 1 - effective.w);
      const y = clamp(drag.origY + dy, 0, 1 - effective.h);
      onCropChange({ ...effective, x, y });
    },
    [effective, onCropChange],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div className="cover-editor">
      <div className="cover-editor__actions">
        <label className="step-edit-panel__upload-label">
          <Upload size={12} />
          <span>{coverUrl ? 'Заменить обложку' : 'Загрузить обложку'}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
            disabled={uploading}
            style={{ display: 'none' }}
          />
        </label>
        {coverUrl && (
          <button
            type="button"
            className="step-edit-panel__cue-delete"
            onClick={onRemove}
            title="Убрать обложку"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {error && <div className="step-edit-panel__error">{error}</div>}

      {coverUrl && (
        <>
          <div className="cover-editor__stage" ref={frameRef}>
            <img
              src={`${API_BASE_URL}${coverUrl}`}
              alt="cover"
              className="cover-editor__img"
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth && img.naturalHeight) {
                  setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                }
              }}
            />
            <div
              className="cover-editor__crop"
              style={{
                left: `${effective.x * 100}%`,
                top: `${effective.y * 100}%`,
                width: `${effective.w * 100}%`,
                height: `${effective.h * 100}%`,
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          </div>

          <div className="step-edit-panel__field">
            <label>Масштаб рамки (3:2)</label>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.01}
              value={effective.w}
              onChange={(e) => handleWidthChange(Number(e.target.value))}
            />
            <span className="step-edit-panel__field-hint">
              Перетащите рамку, чтобы выбрать видимую зону обложки.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
