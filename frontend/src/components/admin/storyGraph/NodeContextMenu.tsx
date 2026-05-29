/**
 * Контекстное меню для ноды (ПКМ) — удаление, будущие действия.
 */
import React, { useEffect, useRef } from 'react';
import { Trash2, Copy, Play } from 'lucide-react';
import './NodeContextMenu.scss';

export interface NodeContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  isEntry: boolean;
  onDelete: (nodeId: string) => void;
  onSetEntry: (nodeId: string) => void;
  onClose: () => void;
}

export default function NodeContextMenu({
  x,
  y,
  nodeId,
  isEntry,
  onDelete,
  onSetEntry,
  onClose,
}: NodeContextMenuProps) {
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
      {!isEntry && (
        <button
          type="button"
          className="node-ctx-menu__item"
          onClick={() => { onSetEntry(nodeId); onClose(); }}
        >
          <Play size={14} />
          Назначить стартом
        </button>
      )}
      <button
        type="button"
        className="node-ctx-menu__item node-ctx-menu__item--danger"
        onClick={() => { onDelete(nodeId); onClose(); }}
      >
        <Trash2 size={14} />
        Удалить шаг
      </button>
    </div>
  );
}
