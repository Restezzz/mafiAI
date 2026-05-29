/**
 * Node-based редактор сюжета (этап 4 — n8n-style canvas).
 *
 * Реализованные этапы:
 * - 4.1–4.2: ноды, edges, drag-n-drop, palette, delete, auto-layout dagre.
 * - 4.3: popup-эдит cues по double-click на ноду (StepEditPanel).
 * - 4.4: popup-эдит condition по double-click на edge (EdgeEditPanel).
 * - 4.5: sidebar Story settings (StorySettingsPanel); canvas — основной маршрут,
 *         старый табличный редактор перенесён в /legacy.
 *
 * Хранилище позиций — БД (story_steps.position_x/position_y), миграция уже была
 * в 20260526_story_engine_tables. PATCH endpoint добавлен в 4.1 (admin_stories.py).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  Connection,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { adminStoriesApi, StoryReadFull, StoryStep, StoryStepKind, StoryTransition } from '../../api/adminStoriesApi';
import { logger } from '../../services/logger';
import { parseApiError } from '../../utils/parseApiError';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import StepNode, { StepNodeData } from '../../components/admin/storyGraph/StepNode';
import { applyDagreLayout, isLayoutEmpty } from '../../components/admin/storyGraph/dagreLayout';
import NodePalette, { DRAG_TYPE } from '../../components/admin/storyGraph/NodePalette';
import NodeContextMenu from '../../components/admin/storyGraph/NodeContextMenu';
import EdgeContextMenu from '../../components/admin/storyGraph/EdgeContextMenu';
import PaneContextMenu from '../../components/admin/storyGraph/PaneContextMenu';
import StepEditPanel from '../../components/admin/storyGraph/StepEditPanel';
import EdgeEditPanel from '../../components/admin/storyGraph/EdgeEditPanel';
import StorySettingsPanel from '../../components/admin/storyGraph/StorySettingsPanel';
import { Trash2, LayoutGrid, Save, ArrowLeft, Settings } from 'lucide-react';
import './AdminStoryGraphPage.scss';

const nodeTypes = { step: StepNode };

// Дебаунс сохранения layout — 600мс после последнего drag, чтобы не спамить
// PATCH-запросы при каждом сдвиге курсора. С 30-шаговым seed это критично.
const LAYOUT_SAVE_DEBOUNCE_MS = 600;

function buildEdges(transitions: StoryTransition[]): Edge[] {
  return transitions.map((t) => {
    const hasCondition = t.condition !== null;
    return {
      id: t.id,
      source: t.from_step_id,
      target: t.to_step_id,
      // Метка edge: priority + признак условия. Условие пока не парсим
      // в человекочитаемый текст — это будет в этапе 4.4 (popup-эдит).
      label: hasCondition ? `[p${t.priority}] cond` : t.priority > 0 ? `p${t.priority}` : undefined,
      animated: !hasCondition,
      style: { stroke: hasCondition ? '#f39c12' : '#4a90e2', strokeWidth: 2 },
      labelStyle: { fontSize: 11, fill: '#e0e0e0' },
      labelBgStyle: { fill: '#1a1d22' },
      markerEnd: { type: MarkerType.ArrowClosed, color: hasCondition ? '#f39c12' : '#4a90e2' },
      interactionWidth: 20,
    };
  });
}

function buildNodes(steps: StoryStep[], entryStepId: string | null): Node[] {
  return steps.map((step) => ({
    id: step.id,
    type: 'step',
    position: { x: step.position_x, y: step.position_y },
    data: {
      kind: step.kind,
      label: step.label,
      slug: step.slug,
      isEntry: step.id === entryStepId,
      cuesCount: step.cues.length,
    } satisfies StepNodeData,
  }));
}

/** Auto-increment slug counter per kind — e.g. narration_1, narration_2 ... */
let slugCounter = 0;
function generateSlug(kind: StoryStepKind): string {
  slugCounter += 1;
  return `${kind}_${slugCounter}`;
}
/** Scan existing slugs and bump counter to avoid collisions. */
function initSlugCounter(steps: StoryStep[]): void {
  let max = 0;
  for (const s of steps) {
    const match = s.slug.match(/_(\d+)$/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  slugCounter = max;
}

function StoryGraphInner() {
  const { storyId } = useParams<{ storyId: string }>();
  const navigate = useNavigate();
  const reactFlowInstance = useReactFlow();
  const [story, setStory] = useState<StoryReadFull | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string; isEntry: boolean } | null>(null);
  const [edgeCtxMenu, setEdgeCtxMenu] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  const [editingStep, setEditingStep] = useState<StoryStep | null>(null);
  const [editingTransition, setEditingTransition] = useState<StoryTransition | null>(null);
  const [paneCtxMenu, setPaneCtxMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const reactFlowWrapperRef = useRef<HTMLDivElement>(null);

  // Дебаунс-таймер сохранения позиций. Пересоздаётся при каждом drag.
  const saveTimerRef = useRef<number | null>(null);
  // Накопитель сдвинутых нод — чтобы один PATCH покрывал все ноды,
  // которые юзер успел подвинуть до того как дебаунс сработал.
  const pendingPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  const fetchStory = useCallback(async () => {
    if (!storyId) return;
    try {
      const res = await adminStoriesApi.get(storyId);
      const data = res.data;
      setStory(data);
      initSlugCounter(data.steps);
      const initialNodes = buildNodes(data.steps, data.entry_step_id);
      const initialEdges = buildEdges(data.transitions);

      // Auto-layout если у сюжета все позиции в (0,0) — типичный случай для
      // seed-сюжетов до первого открытия в node-редакторе.
      const positions = data.steps.map((s) => ({ x: s.position_x, y: s.position_y }));
      const needsAutoLayout = isLayoutEmpty(positions);
      const finalNodes = needsAutoLayout
        ? applyDagreLayout(initialNodes, initialEdges)
        : initialNodes;

      setNodes(finalNodes);
      setEdges(initialEdges);

      // Если применили auto-layout — сразу сохраним в БД, чтобы при следующем
      // открытии не пересчитывать (и чтобы user-перетаскивание дельта-сохранялось).
      if (needsAutoLayout && finalNodes.length > 0) {
        const positionsPayload = finalNodes.map((n) => ({
          step_id: n.id,
          position_x: Math.round(n.position.x),
          position_y: Math.round(n.position.y),
        }));
        try {
          await adminStoriesApi.updateLayout(storyId, positionsPayload);
          logger.info('admin.story.auto_layout_applied', 'Auto-layout applied and saved', {
            story_id: storyId,
            nodes_count: finalNodes.length,
          });
        } catch (saveErr) {
          // Не критично — позиции применятся локально, при следующем открытии
          // dagre снова посчитает (детерминистический алгоритм).
          logger.warn('admin.story.auto_layout_save_failed', 'Auto-layout save failed', {
            error: parseApiError(saveErr),
          });
        }
      }
    } catch (err) {
      setError(getApiErrorMessage(err) ?? 'Не удалось загрузить сюжет');
      logger.warn('admin.story.fetch_failed', 'Failed to fetch story for graph editor', {
        story_id: storyId,
        error: parseApiError(err),
      });
    } finally {
      setLoading(false);
    }
  }, [storyId]);

  useEffect(() => {
    if (!storyId) {
      navigate('/admin/stories');
      return;
    }
    void fetchStory();
  }, [storyId, navigate, fetchStory]);

  // Сохранение pending-позиций одним bulk-запросом.
  const flushPositions = useCallback(async () => {
    if (!storyId) return;
    const map = pendingPositionsRef.current;
    if (map.size === 0) return;
    const positionsPayload = Array.from(map.entries()).map(([step_id, pos]) => ({
      step_id,
      position_x: Math.round(pos.x),
      position_y: Math.round(pos.y),
    }));
    pendingPositionsRef.current = new Map();
    setSavingLayout(true);
    try {
      await adminStoriesApi.updateLayout(storyId, positionsPayload);
      logger.debug('admin.story.layout_saved', 'Story layout saved', {
        story_id: storyId,
        updated: positionsPayload.length,
      });
    } catch (err) {
      logger.warn('admin.story.layout_save_failed', 'Story layout save failed', {
        error: parseApiError(err),
      });
    } finally {
      setSavingLayout(false);
    }
  }, [storyId]);

  // Запуск дебаунс-таймера. При повторных вызовах — отменяет предыдущий.
  const scheduleLayoutSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void flushPositions();
      saveTimerRef.current = null;
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }, [flushPositions]);

  // Обработчик изменений нод от xyflow. Внутри ChangeEvent есть события
  // 'position' (drag start/move/end) — собираем позиции в pendingPositionsRef.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        for (const ch of changes) {
          if (ch.type === 'position' && ch.position && ch.dragging === false) {
            // Сохраняем только когда drag завершён (dragging=false).
            // Промежуточные события — лишний шум.
            pendingPositionsRef.current.set(ch.id, ch.position);
            scheduleLayoutSave();
          }
        }
        return next;
      });
    },
    [scheduleLayoutSave],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  // ---- 4.2: Drop from palette → create step ----
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(DRAG_TYPE) as StoryStepKind;
      if (!kind || !storyId) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const slug = generateSlug(kind);
      try {
        const res = await adminStoriesApi.createStep(storyId, {
          slug,
          kind,
          label: '',
          position_x: Math.round(position.x),
          position_y: Math.round(position.y),
        });
        const step = res.data;
        const newNode: Node = {
          id: step.id,
          type: 'step',
          position: { x: step.position_x, y: step.position_y },
          data: {
            kind: step.kind,
            label: step.label,
            slug: step.slug,
            isEntry: false,
            cuesCount: 0,
          } satisfies StepNodeData,
        };
        setNodes((prev) => [...prev, newNode]);
        setStory((prev) =>
          prev ? { ...prev, steps: [...prev.steps, step] } : prev,
        );
        logger.info('admin.story.step_created', 'Step created from palette', {
          story_id: storyId,
          step_id: step.id,
          kind,
        });
      } catch (err) {
        logger.warn('admin.story.step_create_failed', 'Failed to create step from palette', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, reactFlowInstance],
  );

  // ---- 4.2: Connect handles → create transition ----
  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!storyId || !connection.source || !connection.target) return;
      if (connection.source === connection.target) return; // no self-loops

      try {
        const res = await adminStoriesApi.createTransition(storyId, {
          from_step_id: connection.source,
          to_step_id: connection.target,
        });
        const t = res.data;
        const hasCondition = t.condition !== null;
        const newEdge: Edge = {
          id: t.id,
          source: t.from_step_id,
          target: t.to_step_id,
          label: hasCondition ? `[p${t.priority}] cond` : t.priority > 0 ? `p${t.priority}` : undefined,
          animated: !hasCondition,
          style: { stroke: hasCondition ? '#f39c12' : '#4a90e2', strokeWidth: 2 },
          labelStyle: { fontSize: 11, fill: '#e0e0e0' },
          labelBgStyle: { fill: '#1a1d22' },
          markerEnd: { type: MarkerType.ArrowClosed, color: hasCondition ? '#f39c12' : '#4a90e2' },
        };
        setEdges((prev) => addEdge(newEdge, prev));
        setStory((prev) =>
          prev ? { ...prev, transitions: [...prev.transitions, t] } : prev,
        );
        logger.info('admin.story.transition_created', 'Transition created from handle', {
          story_id: storyId,
          transition_id: t.id,
        });
      } catch (err) {
        logger.warn('admin.story.transition_create_failed', 'Failed to create transition', {
          error: parseApiError(err),
        });
      }
    },
    [storyId],
  );

  // ---- 4.2: Delete nodes/edges ----
  const onNodesDelete = useCallback(
    async (deleted: Node[]) => {
      if (!storyId) return;
      for (const node of deleted) {
        try {
          await adminStoriesApi.deleteStep(storyId, node.id);
          setStory((prev) =>
            prev
              ? {
                  ...prev,
                  steps: prev.steps.filter((s) => s.id !== node.id),
                  transitions: prev.transitions.filter(
                    (t) => t.from_step_id !== node.id && t.to_step_id !== node.id,
                  ),
                }
              : prev,
          );
          logger.info('admin.story.step_deleted', 'Step deleted', {
            story_id: storyId,
            step_id: node.id,
          });
        } catch (err) {
          logger.warn('admin.story.step_delete_failed', 'Failed to delete step', {
            error: parseApiError(err),
          });
        }
      }
    },
    [storyId],
  );

  const onEdgesDelete = useCallback(
    async (deleted: Edge[]) => {
      if (!storyId) return;
      for (const edge of deleted) {
        try {
          await adminStoriesApi.deleteTransition(storyId, edge.id);
          setStory((prev) =>
            prev
              ? { ...prev, transitions: prev.transitions.filter((t) => t.id !== edge.id) }
              : prev,
          );
          logger.info('admin.story.transition_deleted', 'Transition deleted', {
            story_id: storyId,
            transition_id: edge.id,
          });
        } catch (err) {
          logger.warn('admin.story.transition_delete_failed', 'Failed to delete transition', {
            error: parseApiError(err),
          });
        }
      }
    },
    [storyId],
  );

  // ---- 4.2: Context menu (right-click) ----
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const stepData = node.data as StepNodeData;
      setCtxMenu({
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
        isEntry: stepData.isEntry,
      });
    },
    [],
  );

  const handleDeleteFromMenu = useCallback(
    async (nodeId: string) => {
      if (!storyId) return;
      try {
        await adminStoriesApi.deleteStep(storyId, nodeId);
        setNodes((prev) => prev.filter((n) => n.id !== nodeId));
        setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
        setStory((prev) =>
          prev
            ? {
                ...prev,
                steps: prev.steps.filter((s) => s.id !== nodeId),
                transitions: prev.transitions.filter(
                  (t) => t.from_step_id !== nodeId && t.to_step_id !== nodeId,
                ),
              }
            : prev,
        );
      } catch (err) {
        logger.warn('admin.story.step_delete_failed', 'Failed to delete step', { error: parseApiError(err) });
      }
    },
    [storyId],
  );

  const handleSetEntry = useCallback(
    async (nodeId: string) => {
      if (!storyId) return;
      try {
        await adminStoriesApi.update(storyId, { entry_step_id: nodeId });
        setStory((prev) => prev ? { ...prev, entry_step_id: nodeId } : prev);
        setNodes((prev) =>
          prev.map((n) => ({
            ...n,
            data: { ...n.data, isEntry: n.id === nodeId },
          })),
        );
      } catch (err) {
        logger.warn('admin.story.set_entry_failed', 'Failed to set entry step', { error: parseApiError(err) });
      }
    },
    [storyId],
  );

  // ---- 4.2: Trash zone on node drag ----
  const onNodeDragStart = useCallback(() => setIsDraggingNode(true), []);
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      setIsDraggingNode(false);
      // Check if dropped on trash zone (bottom-center area)
      const wrapper = reactFlowWrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const mouseX = _event.clientX;
      const mouseY = _event.clientY;
      const trashZoneY = rect.bottom - 80;
      const trashZoneLeft = rect.left + rect.width / 2 - 80;
      const trashZoneRight = rect.left + rect.width / 2 + 80;
      if (mouseY >= trashZoneY && mouseX >= trashZoneLeft && mouseX <= trashZoneRight) {
        void handleDeleteFromMenu(node.id);
      }
    },
    [handleDeleteFromMenu],
  );

  // ---- 4.3: Double-click → open step edit panel ----
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!story) return;
      const step = story.steps.find((s) => s.id === node.id);
      if (step) {
        setEditingStep(step);
        setShowSettings(false);
      }
    },
    [story],
  );

  const handleStepUpdated = useCallback(
    (updatedStep: StoryStep) => {
      setStory((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          steps: prev.steps.map((s) => (s.id === updatedStep.id ? updatedStep : s)),
        };
      });
      // Sync node data
      setNodes((prev) =>
        prev.map((n) =>
          n.id === updatedStep.id
            ? {
                ...n,
                data: {
                  ...n.data,
                  label: updatedStep.label,
                  slug: updatedStep.slug,
                  cuesCount: updatedStep.cues.length,
                },
              }
            : n,
        ),
      );
      setEditingStep(updatedStep);
    },
    [],
  );

  // ---- 4.4: Double-click edge → open transition edit panel ----
  const onEdgeDoubleClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      if (!story) return;
      const t = story.transitions.find((tr) => tr.id === edge.id);
      if (t) {
        setEditingStep(null);
        setShowSettings(false);
        setEditingTransition(t);
      }
    },
    [story],
  );

  const handleTransitionUpdated = useCallback(
    (updated: StoryTransition) => {
      setStory((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          transitions: prev.transitions.map((t) => (t.id === updated.id ? updated : t)),
        };
      });
      // Sync edge visuals
      const hasCondition = updated.condition !== null;
      setEdges((prev) =>
        prev.map((e) =>
          e.id === updated.id
            ? {
                ...e,
                label: hasCondition
                  ? `[p${updated.priority}] cond`
                  : updated.priority > 0
                    ? `p${updated.priority}`
                    : undefined,
                animated: !hasCondition,
                style: { stroke: hasCondition ? '#f39c12' : '#4a90e2', strokeWidth: 2 },
                markerEnd: { type: MarkerType.ArrowClosed, color: hasCondition ? '#f39c12' : '#4a90e2' },
              }
            : e,
        ),
      );
      setEditingTransition(updated);
    },
    [],
  );

  // ---- Pane context menu (right-click on empty canvas) ----
  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      const flowPos = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setPaneCtxMenu({
        x: event.clientX,
        y: event.clientY,
        flowX: flowPos.x,
        flowY: flowPos.y,
      });
    },
    [reactFlowInstance],
  );

  const handleAddNodeFromPaneMenu = useCallback(
    async (kind: StoryStepKind) => {
      if (!storyId || !paneCtxMenu) return;
      const slug = generateSlug(kind);
      try {
        const res = await adminStoriesApi.createStep(storyId, {
          slug,
          kind,
          label: '',
          position_x: Math.round(paneCtxMenu.flowX),
          position_y: Math.round(paneCtxMenu.flowY),
        });
        const step = res.data;
        const newNode: Node = {
          id: step.id,
          type: 'step',
          position: { x: step.position_x, y: step.position_y },
          data: {
            kind: step.kind,
            label: step.label,
            slug: step.slug,
            isEntry: false,
            cuesCount: 0,
          } satisfies StepNodeData,
        };
        setNodes((prev) => [...prev, newNode]);
        setStory((prev) =>
          prev ? { ...prev, steps: [...prev.steps, step] } : prev,
        );
      } catch (err) {
        logger.warn('admin.story.step_create_failed', 'Failed to create step from pane menu', {
          error: parseApiError(err),
        });
      }
    },
    [storyId, paneCtxMenu],
  );

  // ---- 4.2: Edge context menu (right-click on edge) ----
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      // Select this edge to visually highlight it
      setEdges((prev) =>
        prev.map((e) => ({ ...e, selected: e.id === edge.id })),
      );
      setEdgeCtxMenu({ x: event.clientX, y: event.clientY, edgeId: edge.id });
    },
    [],
  );

  const handleDeleteEdgeFromMenu = useCallback(
    async (edgeId: string) => {
      if (!storyId) return;
      try {
        await adminStoriesApi.deleteTransition(storyId, edgeId);
        setEdges((prev) => prev.filter((e) => e.id !== edgeId));
        setStory((prev) =>
          prev ? { ...prev, transitions: prev.transitions.filter((t) => t.id !== edgeId) } : prev,
        );
      } catch (err) {
        logger.warn('admin.story.transition_delete_failed', 'Failed to delete transition', { error: parseApiError(err) });
      }
    },
    [storyId],
  );

  // Ручной запуск auto-layout. После раскладки сохраняем позиции в БД.
  const handleAutoLayout = useCallback(() => {
    setNodes((current) => {
      const relayouted = applyDagreLayout(current, edges);
      // Сразу планируем сохранение через тот же дебаунс-механизм.
      relayouted.forEach((n) => {
        pendingPositionsRef.current.set(n.id, n.position);
      });
      scheduleLayoutSave();
      return relayouted;
    });
  }, [edges, scheduleLayoutSave]);

  // На unmount — flush pending-позиций (на случай если юзер закрыл вкладку
  // в течение дебаунс-окна).
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        // Синхронно flush невозможен, но axios-запрос уйдёт fire-and-forget.
        // Если страница закрыта раньше — позиции не сохранятся, юзер увидит
        // dagre auto-layout при следующем открытии.
        void flushPositions();
      }
    };
  }, [flushPositions]);

  const stepsCount = story?.steps.length ?? 0;
  const transitionsCount = story?.transitions.length ?? 0;

  const headerInfo = useMemo(() => {
    if (!story) return '';
    return `${stepsCount} шаг(ов), ${transitionsCount} переход(ов)`;
  }, [story, stepsCount, transitionsCount]);

  if (loading) {
    return <div className="admin-story-graph admin-story-graph--loading">Загрузка графа…</div>;
  }

  if (error || !story) {
    return (
      <div className="admin-story-graph admin-story-graph--error">
        <div className="admin-error-banner">{error || 'Сюжет не найден'}</div>
        <Link to="/admin/stories" className="admin-btn">← К списку сюжетов</Link>
      </div>
    );
  }

  return (
    <div className="admin-story-graph">
      <header className="admin-story-graph__toolbar">
        <div className="admin-story-graph__title">
          <Link to="/admin/stories" className="admin-btn admin-btn--small">
            <ArrowLeft size={14} /> К списку
          </Link>
          <h2>
            {story.name}
            <span className="admin-story-graph__version">v{story.version}</span>
          </h2>
          <span className="admin-story-graph__hint">{headerInfo}</span>
        </div>
        <div className="admin-story-graph__actions">
          {savingLayout && (
            <span className="admin-story-graph__saving">
              <Save size={12} /> сохраняю…
            </span>
          )}
          <button
            type="button"
            className="admin-btn admin-btn--small"
            onClick={handleAutoLayout}
            title="Пересобрать раскладку алгоритмом dagre"
          >
            <LayoutGrid size={14} /> Авто-раскладка
          </button>
          <button
            type="button"
            className={`admin-btn admin-btn--small${showSettings ? ' admin-btn--active' : ''}`}
            onClick={() => {
              setShowSettings((v) => !v);
              setEditingStep(null);
              setEditingTransition(null);
            }}
            title="Настройки сюжета"
          >
            <Settings size={14} /> Настройки
          </button>
        </div>
      </header>

      <div className="admin-story-graph__body">
        <div
          className="admin-story-graph__canvas"
          ref={reactFlowWrapperRef}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onPaneClick={() => {
              setCtxMenu(null);
              setEdgeCtxMenu(null);
              setPaneCtxMenu(null);
              setEdges((prev) => prev.map((e) => ({ ...e, selected: false })));
            }}
            onPaneContextMenu={onPaneContextMenu}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1}
            maxZoom={2}
            deleteKeyCode={['Delete', 'Backspace']}
            nodesConnectable={true}
          >
            <Background gap={24} size={1} color="#2a2d33" />
            <Controls />
            <MiniMap
              nodeColor="#4a90e2"
              maskColor="rgba(15, 17, 21, 0.8)"
              style={{ background: '#1a1d22' }}
            />
          </ReactFlow>

          {isDraggingNode && (
            <div className="admin-story-graph__trash-zone">
              <Trash2 size={20} />
              <span>Удалить</span>
            </div>
          )}
        </div>

        {editingStep && storyId ? (
          <StepEditPanel
            storyId={storyId}
            step={editingStep}
            onClose={() => setEditingStep(null)}
            onStepUpdated={handleStepUpdated}
          />
        ) : editingTransition && storyId && story ? (
          <EdgeEditPanel
            storyId={storyId}
            transition={editingTransition}
            steps={story.steps}
            onClose={() => setEditingTransition(null)}
            onTransitionUpdated={handleTransitionUpdated}
          />
        ) : showSettings && story ? (
          <StorySettingsPanel
            story={story}
            onClose={() => setShowSettings(false)}
            onStoryUpdated={(updated: StoryReadFull) => {
              setStory(updated);
              setNodes((prev) =>
                prev.map((n) => {
                  const step = updated.steps.find((s: StoryStep) => s.id === n.id);
                  if (!step) return n;
                  return {
                    ...n,
                    data: { ...n.data, label: step.label, slug: step.slug, cuesCount: step.cues.length },
                  };
                }),
              );
            }}
          />
        ) : (
          <NodePalette
            collapsed={paletteCollapsed}
            onToggle={() => setPaletteCollapsed((v) => !v)}
          />
        )}
      </div>

      {ctxMenu && (
        <NodeContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          nodeId={ctxMenu.nodeId}
          isEntry={ctxMenu.isEntry}
          onDelete={handleDeleteFromMenu}
          onSetEntry={handleSetEntry}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {edgeCtxMenu && (
        <EdgeContextMenu
          x={edgeCtxMenu.x}
          y={edgeCtxMenu.y}
          edgeId={edgeCtxMenu.edgeId}
          onDelete={handleDeleteEdgeFromMenu}
          onClose={() => setEdgeCtxMenu(null)}
        />
      )}

      {paneCtxMenu && (
        <PaneContextMenu
          x={paneCtxMenu.x}
          y={paneCtxMenu.y}
          onAddNode={handleAddNodeFromPaneMenu}
          onClose={() => setPaneCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default function AdminStoryGraphPage() {
  return (
    <ReactFlowProvider>
      <StoryGraphInner />
    </ReactFlowProvider>
  );
}
