/**
 * Visual graph view для Story Engine (этап 4.2).
 *
 * Использует @xyflow/react. Отображает:
 * - Шаги как ноды (custom компонент с цветом по kind, подсветкой entry,
 *   slug + label).
 * - Переходы как edges (label = condition.type или 'else' для безусловных,
 *   priority = метка справа).
 * - Drag-n-drop: при перетаскивании ноды позиция сохраняется в БД через
 *   adminStoriesApi.updateStep с дебаунсом 400ms (чтобы не зафлудить
 *   PUT-запросами).
 *
 * Минимальная функциональность — только перемещение нод. CRUD (создание
 * нод, edges) делается через таблицы выше — текущий граф служит навигатором
 * и предпросмотром.
 *
 * Click on node → выбор → вызов onSelectStep(slug) для синка с боковой
 * панелью деталей. Sentinel: одна и та же нода не двигается зря (epsilon
 * сравнение перед PUT'ом).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  type NodeChange,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  adminStoriesApi,
  StoryReadFull,
  StoryStep,
  StoryTransition,
} from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import './StoryGraphView.scss';

// ---------------------------------------------------------------------------
// Цветовая палитра по kind. Те же оттенки, что в admin-pill, чтобы хост
// узнавал шаги по виду.
// ---------------------------------------------------------------------------
const KIND_COLORS: Record<string, string> = {
  narration: '#5fa05f',
  role_action: '#a4b8e4',
  branch: '#d8a96a',
  pause: '#8c8f95',
  end: '#c81e1e',
  resolve_night: '#b08bff',
  resolve_votes: '#b08bff',
};

function colorFor(kind: string): string {
  return KIND_COLORS[kind] ?? '#6c757d';
}

// ---------------------------------------------------------------------------
// Auto-layout: если у всех шагов position_x=position_y=0, раскладываем в
// сетку. Колонки = topological-уровни (BFS от entry), строки = индекс
// внутри уровня.
// ---------------------------------------------------------------------------
const COL_WIDTH = 280;
const ROW_HEIGHT = 110;

function autoLayout(
  steps: StoryStep[],
  transitions: StoryTransition[],
  entryStepId: string | null,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (steps.length === 0) return positions;

  // Adj-list по step_id.
  const adj = new Map<string, string[]>();
  for (const s of steps) adj.set(s.id, []);
  for (const t of transitions) {
    const arr = adj.get(t.from_step_id);
    if (arr) arr.push(t.to_step_id);
  }

  // BFS-уровни от entry. Если entry не задан — берём первую ноду.
  const start = entryStepId && adj.has(entryStepId) ? entryStepId : steps[0].id;
  const level = new Map<string, number>();
  const queue: string[] = [start];
  level.set(start, 0);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const nextLvl = (level.get(cur) ?? 0) + 1;
    for (const nb of adj.get(cur) ?? []) {
      if (!level.has(nb)) {
        level.set(nb, nextLvl);
        queue.push(nb);
      }
    }
  }
  // Недостижимые — вынесем в level=max+1.
  let maxLvl = 0;
  Array.from(level.values()).forEach((v) => {
    if (v > maxLvl) maxLvl = v;
  });
  for (const s of steps) if (!level.has(s.id)) level.set(s.id, maxLvl + 1);

  // Группировка по level.
  const byLevel = new Map<number, string[]>();
  Array.from(level.entries()).forEach(([id, lvl]) => {
    const arr = byLevel.get(lvl) ?? [];
    arr.push(id);
    byLevel.set(lvl, arr);
  });

  Array.from(byLevel.entries()).forEach(([lvl, ids]) => {
    ids.forEach((id: string, idx: number) => {
      positions.set(id, { x: lvl * COL_WIDTH, y: idx * ROW_HEIGHT });
    });
  });
  return positions;
}

// ---------------------------------------------------------------------------
// Custom node компонент.
// ---------------------------------------------------------------------------
interface StoryNodeData extends Record<string, unknown> {
  slug: string;
  label: string;
  kind: string;
  isEntry: boolean;
  cuesCount: number;
}

function StoryNode({ data, selected }: NodeProps<Node<StoryNodeData>>) {
  const accent = colorFor(data.kind);
  return (
    <div
      className={`story-node${selected ? ' story-node--selected' : ''}`}
      style={{ borderLeftColor: accent }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="story-node__header">
        <span className="story-node__kind" style={{ background: accent }}>
          {data.kind}
        </span>
        {data.isEntry && <span className="story-node__entry">entry</span>}
      </div>
      <div className="story-node__slug">{data.slug}</div>
      {data.label && <div className="story-node__label">{data.label}</div>}
      {data.cuesCount > 0 && (
        <div className="story-node__cues">{data.cuesCount} фраз</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { story: StoryNode };

// ---------------------------------------------------------------------------
// Главный компонент.
// ---------------------------------------------------------------------------
interface Props {
  story: StoryReadFull;
  onSelectStep?: (stepId: string | null) => void;
  /** Можно ли таскать ноды (требует admin прав; backend всё равно проверит). */
  editable?: boolean;
  /** Создать transition (drag connect handle). null — disable connect. */
  onConnectEdge?: (params: { fromStepId: string; toStepId: string }) => void;
  /** Delete клавиша по выделенной ноде (UUID step). */
  onDeleteStep?: (stepId: string) => void;
  /** Delete клавиша по выделенному edge (UUID transition). */
  onDeleteEdge?: (transitionId: string) => void;
}

export default function StoryGraphView({
  story,
  onSelectStep,
  editable = true,
  onConnectEdge,
  onDeleteStep,
  onDeleteEdge,
}: Props) {
  // Считаем initial-позиции один раз. Изменение story → пересчёт через key.
  const initialNodes = useMemo<Node<StoryNodeData>[]>(() => {
    const allZero = story.steps.every(
      (s) => s.position_x === 0 && s.position_y === 0,
    );
    const layout = allZero
      ? autoLayout(story.steps, story.transitions, story.entry_step_id)
      : null;
    return story.steps.map((s) => {
      const pos = layout?.get(s.id) ?? { x: s.position_x, y: s.position_y };
      return {
        id: s.id,
        type: 'story',
        position: pos,
        data: {
          slug: s.slug,
          label: s.label,
          kind: s.kind,
          isEntry: s.id === story.entry_step_id,
          cuesCount: s.cues.length,
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.id]);

  const initialEdges = useMemo<Edge[]>(() => {
    return story.transitions.map((t) => {
      const condLabel = t.condition
        ? (t.condition as { type?: string }).type ?? 'condition'
        : 'else';
      return {
        id: t.id,
        source: t.from_step_id,
        target: t.to_step_id,
        label: `${condLabel} · p${t.priority}`,
        labelStyle: { fontSize: 10, fill: '#c0c2c8' },
        labelBgStyle: { fill: '#1a1d22', fillOpacity: 0.85 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        style: {
          stroke: t.condition ? '#a4b8e4' : '#6c757d',
          strokeWidth: t.condition ? 1.6 : 1.2,
          strokeDasharray: t.condition ? undefined : '4 3',
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.id]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StoryNodeData>>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialEdges);

  // При смене story (открыли другой) — заменить полный набор.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Дебаунс таймеров на сохранение позиции (per-node).
  const saveTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const lastSavedRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Инициализируем lastSaved исходными координатами, чтобы первое
  // перетаскивание не сравнивалось с (0, 0).
  useEffect(() => {
    const m = lastSavedRef.current;
    for (const n of initialNodes) m.set(n.id, n.position);
  }, [initialNodes]);

  const persistPosition = useCallback(
    (stepId: string, x: number, y: number) => {
      const last = lastSavedRef.current.get(stepId);
      const rx = Math.round(x);
      const ry = Math.round(y);
      if (last && Math.abs(last.x - rx) < 1 && Math.abs(last.y - ry) < 1) {
        return; // ничего не двинулось
      }
      adminStoriesApi
        .updateStep(story.id, stepId, { position_x: rx, position_y: ry })
        .then(() => {
          lastSavedRef.current.set(stepId, { x: rx, y: ry });
        })
        .catch((err) => {
          logger.warn(
            'admin.story.position_save_failed',
            'Failed to persist node position',
            { error: parseApiError(err), stepId },
          );
        });
    },
    [story.id],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<StoryNodeData>>[]) => {
      onNodesChange(changes);
      if (!editable) return;
      for (const c of changes) {
        if (c.type === 'position' && c.position && c.dragging === false) {
          // dragging переключился false → drag закончился. Дебаунс persist.
          const timers = saveTimersRef.current;
          const existing = timers.get(c.id);
          if (existing) clearTimeout(existing);
          const x = c.position.x;
          const y = c.position.y;
          const t = setTimeout(() => persistPosition(c.id, x, y), 200);
          timers.set(c.id, t);
        }
      }
    },
    [onNodesChange, editable, persistPosition],
  );

  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node<StoryNodeData>) => {
      onSelectStep?.(node.id);
    },
    [onSelectStep],
  );

  const handlePaneClick = useCallback(() => {
    onSelectStep?.(null);
  }, [onSelectStep]);

  // Создание transition перетаскиванием из source-handle в target-handle.
  // xyflow сам не добавляет edge — это обязанность колбэка.
  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (conn.source === conn.target) return; // self-loops запрещены
      onConnectEdge?.({ fromStepId: conn.source, toStepId: conn.target });
    },
    [onConnectEdge],
  );

  const handleNodesDelete = useCallback(
    (deleted: Node<StoryNodeData>[]) => {
      if (!onDeleteStep) return;
      for (const n of deleted) onDeleteStep(n.id);
    },
    [onDeleteStep],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (!onDeleteEdge) return;
      for (const e of deleted) onDeleteEdge(e.id);
    },
    [onDeleteEdge],
  );

  // Cleanup таймеров при размонтировании.
  useEffect(() => {
    const timers = saveTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return (
    <div className="story-graph-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onConnect={handleConnect}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        nodeTypes={NODE_TYPES}
        fitView
        nodesDraggable={editable}
        nodesConnectable={editable && Boolean(onConnectEdge)}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#2a2d33" gap={16} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          style={{ background: '#0a0b0e' }}
          nodeColor={(n) => colorFor((n.data as StoryNodeData)?.kind ?? '')}
          maskColor="rgba(10, 11, 14, 0.7)"
        />
      </ReactFlow>
    </div>
  );
}
