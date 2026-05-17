import React, { useRef, useState, useCallback } from 'react';
import { DevLobbyPlayerLink } from '../../types/game';
import './DevPlayerQuickPill.scss';

interface DevPlayerQuickPillProps {
  playerLinks: DevLobbyPlayerLink[];
  onOpenPlayer: (url: string, isHostSlot: boolean) => void;
  onAddPlayer?: () => void;
  addDisabled?: boolean;
  onRemovePlayer?: () => void;
  removeDisabled?: boolean;
  /** Map slot_number → display label (e.g. character name or role). */
  slotLabels?: Record<number, string>;
}

export default function DevPlayerQuickPill({
  playerLinks,
  onOpenPlayer,
  onAddPlayer,
  addDisabled = false,
  onRemovePlayer,
  removeDisabled = false,
  slotLabels,
}: DevPlayerQuickPillProps) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    origin.current = { x: e.clientX, y: e.clientY };
    startPos.current = { ...pos };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    setPos({
      x: startPos.current.x + (e.clientX - origin.current.x),
      y: startPos.current.y + (e.clientY - origin.current.y),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div
      className="dev-player-pill"
      role="group"
      aria-label="Тестовые игроки"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      <div
        className="dev-player-pill__header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="dev-player-pill__title">Тестовые игроки</span>
        <span className="dev-player-pill__actions">
          {onRemovePlayer && (
            <button
              type="button"
              className="dev-player-pill__remove"
              onClick={onRemovePlayer}
              disabled={removeDisabled}
            >
              −
            </button>
          )}
          {onAddPlayer && (
            <button
              type="button"
              className="dev-player-pill__add"
              onClick={onAddPlayer}
              disabled={addDisabled}
            >
              +
            </button>
          )}
        </span>
      </div>
      <div className="dev-player-pill__list">
        {playerLinks.map((link) => {
          const isHostSlot = link.slot_number === 1;
          return (
            <button
              key={link.player_slug}
              type="button"
              className={`dev-player-pill__player ${isHostSlot ? 'dev-player-pill__player--active' : ''}`}
              onClick={() => onOpenPlayer(link.url, isHostSlot)}
              disabled={isHostSlot}
            >
              <span className="dev-player-pill__player-slot">{link.player_slug}</span>
              <span className="dev-player-pill__player-name">{slotLabels?.[link.slot_number] ?? link.player_name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
