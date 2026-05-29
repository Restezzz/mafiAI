/**
 * Контекстное меню для edge (ПКМ по связи) — удаление перехода.
 */
import React, { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import './NodeContextMenu.scss'; // Переиспользуем те же стили

export interface EdgeContextMenuProps {
  x: number;
  y: number;
  edgeId: string;
  onDelete: (edgeId: string) => void;
  onClose: () => void;
}

export default function EdgeContextMenu({
  x,
  y,
  edgeId,
  onDelete,
  onClose,
}: EdgeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="node-ctx-menu"
      style={{ top: y, left: x }}
    >
      <button
        type="button"
        className="node-ctx-menu__item node-ctx-menu__item--danger"
        onClick={() => { onDelete(edgeId); onClose(); }}
      >
        <Trash2 size={14} />
        Удалить связь
      </button>
    </div>
  );
}
