/**
 * Auto-layout для xyflow-графа сюжета через dagre.
 *
 * Используется когда у сюжета все position_x/position_y == 0 (legacy seed,
 * не открывался в node-редакторе) — даём осмысленную раскладку с нуля,
 * чтобы юзер не увидел кучу нод в одной точке.
 *
 * Также может вызываться кнопкой "Авто-раскладка" — тогда последующий
 * drag сохранит позиции в БД через PATCH /stories/{id}/layout.
 */
import dagre from '@dagrejs/dagre';
import { Edge, Node } from '@xyflow/react';

export interface LayoutOptions {
  /** Направление: TB (top→bottom) — стандарт для flowchart, LR (left→right) — n8n-style. */
  direction?: 'TB' | 'LR';
  /** Ширина ноды для расчёта (rendered width, не точное). */
  nodeWidth?: number;
  /** Высота ноды для расчёта. */
  nodeHeight?: number;
  /** Расстояние между нодами одного ранга. */
  nodeSep?: number;
  /** Расстояние между рангами (вертикальное при TB). */
  rankSep?: number;
}

/**
 * Принимает массив nodes/edges xyflow и возвращает копию nodes с обновлёнными
 * позициями. Edges не модифицируются.
 *
 * Координаты dagre — центр ноды; xyflow ожидает левый-верхний угол.
 * Корректируем сдвигом на половину размера.
 */
export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {},
): Node[] {
  const {
    direction = 'TB',
    nodeWidth = 240,
    nodeHeight = 90,
    nodeSep = 50,
    rankSep = 90,
  } = options;

  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: nodeSep, ranksep: rankSep });
  // Дефолтный label для рёбер обязателен — иначе dagre кидает.
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: {
        x: Math.round(pos.x - nodeWidth / 2),
        y: Math.round(pos.y - nodeHeight / 2),
      },
    };
  });
}

/**
 * Эвристика: считаем layout "пустым" (требует auto-layout) если все ноды
 * стоят в (0, 0). Это типично для seed-сюжетов до первого открытия в
 * node-редакторе — БД-дефолт server_default="0" для обоих координат.
 *
 * Если хотя бы одна нода сдвинута — считаем что юзер уже расставил
 * вручную, и не перезаписываем.
 */
export function isLayoutEmpty(positions: Array<{ x: number; y: number }>): boolean {
  if (positions.length === 0) return true;
  return positions.every((p) => p.x === 0 && p.y === 0);
}
