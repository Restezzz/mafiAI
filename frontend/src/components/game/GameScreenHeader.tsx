import React, { useState } from 'react';
import PauseButton from './PauseButton';
import RulesModal, { RulesButton } from './RulesModal';
import { useGameStore } from '../../stores/gameStore';
import './GameScreenHeader.scss';

interface GameScreenHeaderProps {
  title: string;
  timer?: React.ReactNode;
  right?: React.ReactNode;
  showPause?: boolean;
  pauseSlot?: React.ReactNode;
  className?: string;
  /**
   * Показывать вторую строку «Вы играете: имя». По умолчанию true —
   * имя берётся из gameStore (players[myPlayerId].name). Если имени
   * нет (например, в UI-демо или до загрузки /state), строка не
   * рендерится автоматически.
   */
  showCharacterName?: boolean;
  /** Показывать кнопку «Правила» (?) со встроенным модальным окном. */
  showRulesButton?: boolean;
}

export default function GameScreenHeader({
  title,
  timer,
  right,
  showPause = true,
  pauseSlot,
  className,
  showCharacterName = true,
  showRulesButton = false,
}: GameScreenHeaderProps) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  const myPlayer = useGameStore((s) =>
    myPlayerId ? s.players.find((p) => p.id === myPlayerId) ?? null : null,
  );
  const characterName = showCharacterName ? myPlayer?.name ?? null : null;

  const classes = ['game-screen-header', className ?? ''].filter(Boolean).join(' ');
  const left = pauseSlot ?? (showPause ? <PauseButton /> : <span className="game-screen-header__spacer" />);

  return (
    <header className={classes}>
      <div className="game-screen-header__row">
        <div className="game-screen-header__left">{left}</div>
        <h2 className="game-screen-header__title">{title}</h2>
        <div className="game-screen-header__right">
          {right}
          {timer}
          {showRulesButton && <RulesButton onClick={() => setRulesOpen(true)} />}
        </div>
      </div>
      {characterName && (
        <div className="game-screen-header__character">
          <span className="game-screen-header__character-label">Вы играете:</span>
          <span className="game-screen-header__character-name">{characterName}</span>
        </div>
      )}
      {showRulesButton && <RulesModal isOpen={rulesOpen} onClose={() => setRulesOpen(false)} />}
    </header>
  );
}
