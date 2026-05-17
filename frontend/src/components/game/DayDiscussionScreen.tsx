import React, { useMemo } from 'react';
import { useGameStore } from '../../stores/gameStore';
import { useSessionStore } from '../../stores/sessionStore';
import { Player } from '../../types/game';
import { useCountdown } from '../../hooks/useCountdown';
import AmbientBackground from '../ui/AmbientBackground';
import Timer from '../ui/Timer';
import Badge from '../ui/Badge';
import GameScreenHeader from './GameScreenHeader';
import './DayDiscussionScreen.scss';

export default function DayDiscussionScreen() {
  const players = useGameStore((s) => s.players);
  const nightResultDied = useGameStore((s) => s.nightResultDied);
  const dayBlockedPlayer = useGameStore((s) => s.dayBlockedPlayer);
  const myStatus = useGameStore((s) => s.myStatus);
  const phase = useGameStore((s) => s.phase);
  const discussionTimer = useSessionStore((s) => s.settings.discussion_timer_seconds);
  const timerPaused = useSessionStore((s) => s.timerPaused);
  const timeLeft = useCountdown({
    paused: timerPaused,
    fallbackSeconds: discussionTimer,
    timerSeconds: phase?.timer_seconds,
    timerStartedAt: phase?.timer_started_at,
    resetKey: phase?.id ?? 'discussion',
  });

  const { alivePlayers, deadPlayers } = useMemo(() => {
    const alive: Player[] = [];
    const dead: Player[] = [];
    for (const p of players) {
      (p.status === 'alive' ? alive : dead).push(p);
    }
    return { alivePlayers: alive, deadPlayers: dead };
  }, [players]);

  return (
    <div className="day-discussion">
      <AmbientBackground variant="day" />

      <GameScreenHeader
        title="Обсуждение"
        timer={<Timer seconds={timeLeft} dangerThreshold={10} />}
        showRulesButton
      />

      {nightResultDied && nightResultDied.length > 0 && (
        <div className="day-discussion__night-result">
          <div className="day-discussion__night-result-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 9v2m0 4h.01" />
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
          </div>
          <div className="day-discussion__night-result-text">
            <span>Этой ночью погибли:</span>
            {nightResultDied.map((d) => (
              <span key={d.player_id} className="day-discussion__died-name">{d.name}</span>
            ))}
          </div>
        </div>
      )}

      {dayBlockedPlayer && (
        <div className="day-discussion__blocked-notice">
          Игрок {players.find((p) => p.id === dayBlockedPlayer)?.name} не участвует в обсуждении
        </div>
      )}

      <div className="day-discussion__players">
        <div className="day-discussion__section-title">Живые игроки ({alivePlayers.length})</div>
        {alivePlayers.map((player) => (
          <div
            key={player.id}
            className={`day-discussion__player ${player.id === dayBlockedPlayer ? 'day-discussion__player--blocked' : ''}`}
          >
            <div className="day-discussion__player-number">{player.join_order}</div>
            <span className="day-discussion__player-info">
              <span className="day-discussion__player-name">{player.name}</span>
              {player.username && player.username !== player.name && (
                <span className="day-discussion__player-nickname">{player.username}</span>
              )}
            </span>
            {player.id === dayBlockedPlayer && (
              <Badge variant="blocked">Заблокирован</Badge>
            )}
          </div>
        ))}

        {deadPlayers.length > 0 && (
          <>
            <div className="day-discussion__section-title day-discussion__section-title--dead">
              Выбывшие ({deadPlayers.length})
            </div>
            {deadPlayers.map((player) => (
              <div key={player.id} className="day-discussion__player day-discussion__player--dead">
                <div className="day-discussion__player-number">{player.join_order}</div>
                <span className="day-discussion__player-info">
                  <span className="day-discussion__player-name">{player.name}</span>
                  {player.username && player.username !== player.name && (
                    <span className="day-discussion__player-nickname">{player.username}</span>
                  )}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {myStatus === 'dead' && (
        <div className="day-discussion__spectator-notice">
          Вы наблюдаете за игрой
        </div>
      )}
    </div>
  );
}
