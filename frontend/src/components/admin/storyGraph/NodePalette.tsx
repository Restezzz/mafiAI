/**
 * Sidebar-палитра типов нод для node-based редактора (этап 4.2).
 *
 * Каждый тип можно перетащить (HTML5 Drag and Drop) на canvas xyflow.
 * При drop AdminStoryGraphPage создаёт новый StoryStep через API.
 *
 * Drag-data формат: application/reactflow-node-kind = "narration" | "voting" | ...
 */
import React from 'react';
import {
  Megaphone,
  Drama,
  MessageSquare,
  Vote,
  Moon,
  Sun,
  Pause,
  GitBranch,
  Flag,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { StoryStepKind } from '../../../api/adminStoriesApi';
import './NodePalette.scss';

interface KindItem {
  kind: StoryStepKind;
  Icon: LucideIcon;
  label: string;
  color: string;
  description: string;
}

const KINDS: KindItem[] = [
  { kind: 'narration',     Icon: Megaphone,     label: 'Нарратив',      color: '#4a90e2', description: 'Текст/озвучка ведущего' },
  { kind: 'role_action',   Icon: Drama,         label: 'Ход роли',      color: '#9b59b6', description: 'Действие конкретной роли' },
  { kind: 'discussion',    Icon: MessageSquare, label: 'Дискуссия',     color: '#f39c12', description: 'Обсуждение между игроками' },
  { kind: 'voting',        Icon: Vote,          label: 'Голосование',   color: '#e74c3c', description: 'Голосование за исключение' },
  { kind: 'night_resolve', Icon: Moon,          label: 'Резолв ночи',   color: '#34495e', description: 'Обработка ночных действий' },
  { kind: 'day_resolve',   Icon: Sun,           label: 'Резолв дня',    color: '#27ae60', description: 'Обработка дневных итогов' },
  { kind: 'pause',         Icon: Pause,         label: 'Пауза',         color: '#7f8c8d', description: 'Ожидание / таймер' },
  { kind: 'branch',        Icon: GitBranch,     label: 'Развилка',      color: '#16a085', description: 'Условное ветвление' },
  { kind: 'end',           Icon: Flag,          label: 'Финал',         color: '#c0392b', description: 'Конец сюжета' },
];

export const DRAG_TYPE = 'application/reactflow-node-kind';

interface NodePaletteProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export default function NodePalette({ collapsed = false, onToggle }: NodePaletteProps) {
  const onDragStart = (e: React.DragEvent, kind: StoryStepKind) => {
    e.dataTransfer.setData(DRAG_TYPE, kind);
    e.dataTransfer.effectAllowed = 'move';
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="node-palette__expand-btn"
        onClick={onToggle}
        title="Открыть палитру шагов"
      >
        <ChevronLeft size={16} />
      </button>
    );
  }

  return (
    <aside className="node-palette">
      <div className="node-palette__header">
        <span className="node-palette__title">Типы шагов</span>
        {onToggle && (
          <button
            type="button"
            className="node-palette__toggle"
            onClick={onToggle}
            title="Свернуть палитру"
          >
            <ChevronRight size={14} />
          </button>
        )}
      </div>
      <div className="node-palette__list">
        {KINDS.map((item) => (
          <div
            key={item.kind}
            className="node-palette__item"
            draggable
            onDragStart={(e) => onDragStart(e, item.kind)}
            style={{ borderLeftColor: item.color }}
            title={item.description}
          >
            <item.Icon size={16} strokeWidth={2} style={{ color: item.color, flexShrink: 0 }} />
            <div className="node-palette__info">
              <span className="node-palette__kind-label">{item.label}</span>
              <span className="node-palette__desc">{item.description}</span>
            </div>
          </div>
        ))}
        <div className="node-palette__hint">
          Перетащи на canvas для создания шага
        </div>
      </div>
    </aside>
  );
}
