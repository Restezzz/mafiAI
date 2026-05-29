/**
 * Кастомная xyflow-нода для StoryStep — отображает kind + label + slug + entry-badge.
 *
 * Source/target handles: top (incoming) и bottom (outgoing). Это создаёт
 * top-bottom поток (соответствует dagre direction='TB' по умолчанию).
 */
import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import {
  Megaphone,
  Drama,
  MessageSquare,
  Vote,
  Moon,
  Sun,
  GitBranch,
  Flag,
  Mic,
  Play,
  Users,
  IdCard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { StoryStepKind } from '../../../api/adminStoriesApi';
import './StepNode.scss';

export interface StepNodeData {
  kind: StoryStepKind;
  label: string;
  slug: string;
  isEntry: boolean;
  cuesCount: number;
  [key: string]: unknown;
}

const KIND_META: Record<StoryStepKind, { Icon: LucideIcon; label: string; color: string }> = {
  narration:     { Icon: Megaphone,     label: 'Нарратив',     color: '#4a90e2' },
  role_action:   { Icon: Drama,         label: 'Ход роли',     color: '#9b59b6' },
  discussion:    { Icon: MessageSquare, label: 'Дискуссия',    color: '#f39c12' },
  voting:        { Icon: Vote,          label: 'Голосование',  color: '#e74c3c' },
  night_resolve: { Icon: Moon,          label: 'Резолв ночи',  color: '#34495e' },
  day_resolve:   { Icon: Sun,           label: 'Резолв дня',   color: '#27ae60' },
  branch:        { Icon: GitBranch,     label: 'Развилка',     color: '#16a085' },
  end:           { Icon: Flag,          label: 'Финал',        color: '#c0392b' },
  names:         { Icon: Users,         label: 'Имена',        color: '#8e44ad' },
  roles:         { Icon: IdCard,        label: 'Роли',         color: '#d35400' },
};

export default function StepNode({ data, selected }: NodeProps) {
  const stepData = data as StepNodeData;
  const meta = KIND_META[stepData.kind];
  const { Icon } = meta;

  return (
    <div
      className={`step-node ${selected ? 'step-node--selected' : ''} ${stepData.isEntry ? 'step-node--entry' : ''}`}
      style={{ borderColor: selected ? '#4a90e2' : meta.color }}
    >
      <Handle type="target" position={Position.Top} className="step-node__handle" />

      <div className="step-node__inner">
        {stepData.isEntry && (
          <div className="step-node__entry-banner">
            <Play size={10} />
            START
          </div>
        )}

        <div className="step-node__header" style={{ background: meta.color }}>
          <Icon size={14} strokeWidth={2.5} className="step-node__icon" />
          <span className="step-node__kind">{meta.label}</span>
        </div>
        <div className="step-node__body">
          <div className="step-node__label">{stepData.label || <em>(без названия)</em>}</div>
          <div className="step-node__slug">{stepData.slug}</div>
          {stepData.cuesCount > 0 && (
            <div className="step-node__cues">
              <Mic size={11} />
              <span>{stepData.cuesCount} {stepData.cuesCount === 1 ? 'фраза' : 'фраз'}</span>
            </div>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="step-node__handle" />
    </div>
  );
}
