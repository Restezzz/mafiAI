import React, { useMemo, useState } from 'react';
import { AudioFile } from '../../types/narrator';

interface Props {
  audioFiles: AudioFile[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /** Если true — добавляем опцию "не выбрано" (для text-only variant). */
  allowEmpty?: boolean;
}

/**
 * Searchable select поверх <select> — обычный selectный список с фильтром
 * сверху. Не использует datalist (он плохо работает с большими списками
 * и не позволяет напрямую видеть filename).
 *
 * Для admin-панели с 80+ файлами поиск критичен.
 */
export default function AudioSelect({
  audioFiles,
  value,
  onChange,
  disabled,
  allowEmpty,
}: Props) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return audioFiles
      .filter((a) => !q || a.filename.toLowerCase().includes(q))
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }, [audioFiles, filter]);

  return (
    <div>
      <input
        className="admin-input"
        placeholder={`Поиск среди ${audioFiles.length} файлов…`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        disabled={disabled}
        style={{ marginBottom: 6 }}
      />
      <select
        className="admin-select"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        size={Math.min(8, Math.max(3, filtered.length + (allowEmpty ? 1 : 0)))}
        style={{ height: 'auto', padding: '4px 0' }}
      >
        {allowEmpty && (
          <option value="" style={{ padding: '4px 12px' }}>
            — без аудио (text-only) —
          </option>
        )}
        {filtered.map((a) => (
          <option key={a.id} value={a.id} style={{ padding: '4px 12px' }}>
            {a.filename}
            {a.duration_ms ? `  •  ${(a.duration_ms / 1000).toFixed(1)}s` : ''}
          </option>
        ))}
        {filtered.length === 0 && (
          <option disabled style={{ padding: '4px 12px', color: '#8c8f95' }}>
            (ничего не найдено)
          </option>
        )}
      </select>
    </div>
  );
}
