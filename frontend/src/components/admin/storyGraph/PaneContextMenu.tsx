/**
 * Контекстное меню канваса (ПКМ по пустому месту) — добавление нод.
 */
import React, { useEffect, useRef } from 'react';
import {
  Megaphone,
  Drama,
  MessageSquare,
  Vote,
  Moon,
  Sun,
  GitBranch,
  Flag,
  Users,
  IdCard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { StoryStepKind } from '../../../api/adminStoriesApi';
import './NodeContextMenu.scss';

interface KindItem {
  kind: StoryStepKind;
  Icon: LucideIcon;
  label: string;
  color: string;
}

const KINDS: KindItem[] = [
  { kind: 'narration',     Icon: Megaphone,     label: 'Нарратив',      color: '#4a90e2' },
  { kind: 'role_action',   Icon: Drama,         label: 'Ход роли',      color: '#9b59b6' },
  { kind: 'discussion',    Icon: MessageSquare, label: 'Дискуссия',     color: '#f39c12' },
  { kind: 'voting',        Icon: Vote,          label: 'Голосование',   color: '#e74c3c' },
  { kind: 'night_resolve', Icon: Moon,          label: 'Резолв ночи',   color: '#34495e' },
  { kind: 'day_resolve',   Icon: Sun,           label: 'Резолв дня',    color: '#27ae60' },
  { kind: 'branch',        Icon: GitBranch,     label: 'Развилка',      color: '#16a085' },
  { kind: 'end',           Icon: Flag,          label: 'Финал',         color: '#c0392b' },
  { kind: 'names',         Icon: Users,         label: 'Имена',         color: '#8e44ad' },
  { kind: 'roles',         Icon: IdCard,        label: 'Роли',          color: '#d35400' },
];

export interface PaneContextMenuProps {
  x: number;
  y: number;
  onAddNode: (kind: StoryStepKind) => void;
  onClose: () => void;
}

export default function PaneContextMenu({
  x,
  y,
  onAddNode,
  onClose,
}: PaneContextMenuProps) {
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
      <div className="node-ctx-menu__title">Добавить шаг</div>
      {KINDS.map(({ kind, Icon, label, color }) => (
        <button
          key={kind}
          type="button"
          className="node-ctx-menu__item"
          onClick={() => { onAddNode(kind); onClose(); }}
        >
          <Icon size={14} color={color} />
          {label}
        </button>
      ))}
    </div>
  );
}
