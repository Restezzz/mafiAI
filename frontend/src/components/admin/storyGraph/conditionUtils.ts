/**
 * Утилиты для отображения condition перехода (edge) в человекочитаемом виде
 * и для единообразного построения визуала edge (label / цвет / маркер).
 *
 * Используется в AdminStoryGraphPage (buildEdges / onConnect /
 * handleTransitionUpdated), чтобы не дублировать логику в трёх местах.
 */
import { MarkerType } from '@xyflow/react';
import type { Edge } from '@xyflow/react';

type Cond = Record<string, unknown> | null;

/** Короткое человекочитаемое описание условия (для подписи на стрелке/в панели). */
export function describeCondition(condition: Cond): string {
  if (!condition) return '';
  const type = String(condition.type ?? '');
  const role = () => String(condition.role_slug ?? '?');

  switch (type) {
    case 'winner': {
      const team = condition.team;
      return team ? `победа: ${String(team)}` : 'победа: любая';
    }
    case 'phase_number':
      return `фаза ${String(condition.op ?? '?')} ${String(condition.value ?? '?')}`;
    case 'vote_tie':
      return 'ничья на голосовании';
    case 'died_role':
      return `погибла роль: ${role()}`;
    case 'death_cause':
      return `причина смерти: ${String(condition.value ?? '?')}`;
    case 'role_alive':
      return `роль жива: ${role()}`;
    case 'role_dead':
      return `роль мертва: ${role()}`;
    case 'step_var':
      return `${String(condition.key ?? '?')} ${String(condition.op ?? '?')} ${String(condition.value ?? '?')}`;
    case 'all': {
      const conds = Array.isArray(condition.conditions) ? condition.conditions : [];
      return conds.length
        ? conds.map((c) => describeCondition(c as Cond)).join(' И ')
        : 'все (пусто)';
    }
    case 'any': {
      const conds = Array.isArray(condition.conditions) ? condition.conditions : [];
      return conds.length
        ? conds.map((c) => describeCondition(c as Cond)).join(' ИЛИ ')
        : 'любое (пусто)';
    }
    case 'not':
      return `НЕ(${describeCondition((condition.condition ?? null) as Cond)})`;
    default:
      return 'условие';
  }
}

function truncate(value: string, max = 42): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Текст подписи на стрелке: приоритет + краткое условие. */
export function edgeLabel(condition: Cond, priority: number): string | undefined {
  const desc = condition ? describeCondition(condition) : '';
  const prefix = priority > 0 ? `p${priority} · ` : '';
  if (desc) return truncate(`${prefix}${desc}`);
  return priority > 0 ? `p${priority}` : undefined;
}

/** Полный набор визуальных полей edge — единый для создания и обновления. */
export function edgeVisual(condition: Cond, priority: number): Partial<Edge> {
  const hasCondition = condition !== null;
  return {
    label: edgeLabel(condition, priority),
    animated: !hasCondition,
    style: { stroke: hasCondition ? '#f39c12' : '#4a90e2', strokeWidth: 2 },
    labelStyle: { fontSize: 11, fill: '#e0e0e0' },
    labelBgStyle: { fill: '#1a1d22' },
    markerEnd: { type: MarkerType.ArrowClosed, color: hasCondition ? '#f39c12' : '#4a90e2' },
    interactionWidth: 20,
  };
}
