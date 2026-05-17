import React, { useState } from 'react';
import { useGameStore } from '../../stores/gameStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useCountdown } from '../../hooks/useCountdown';
import AmbientBackground from '../ui/AmbientBackground';
import Timer from '../ui/Timer';
import ProgressBar from '../ui/ProgressBar';
import SelectableCard from '../ui/SelectableCard';
import GameScreenHeader from './GameScreenHeader';
import './DayVotingScreen.scss';

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export default function DayVotingScreen() {
  const availableTargets = useGameStore((s) => s.availableTargets);
  const voteSubmitted = useGameStore((s) => s.voteSubmitted);
  const votes = useGameStore((s) => s.votes);
  const myStatus = useGameStore((s) => s.myStatus);
  const dayBlockedPlayer = useGameStore((s) => s.dayBlockedPlayer);
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  const submitVote = useGameStore((s) => s.submitVote);
  const phase = useGameStore((s) => s.phase);
  const votingTimer = useSessionStore((s) => s.settings.voting_timer_seconds);
  const timerPaused = useSessionStore((s) => s.timerPaused);

  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timeLeft = useCountdown({
    paused: timerPaused || voteSubmitted,
    fallbackSeconds: votingTimer,
    timerSeconds: phase?.timer_seconds,
    timerStartedAt: phase?.timer_started_at,
    resetKey: phase?.id ?? 'voting',
  });

  const isBlocked = myPlayerId === dayBlockedPlayer;
  const canVote = myStatus === 'alive' && !isBlocked && !voteSubmitted;

  const handleConfirmVote = async () => {
    if (!canVote || !selectedTarget || submitting) return;
    setSubmitting(true);
    try {
      await submitVote(selectedTarget);
    } catch {
      // Keep the button enabled so the user can retry.
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkipVote = async () => {
    if (!canVote || submitting) return;
    setSubmitting(true);
    try {
      await submitVote(null);
    } catch {
      // Swallow.
    } finally {
      setSubmitting(false);
    }
  };

  if (voteSubmitted) {
    const progressValue = votes ? (votes.cast / votes.total_expected) * 100 : 0;
    return (
      <div className="day-voting day-voting--submitted">
        <AmbientBackground variant="voting" />
        <div className="day-voting__submitted-content">
          <div className="day-voting__check-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 className="day-voting__submitted-title">Голос принят</h2>
          <p className="day-voting__submitted-hint">
            {votes
              ? `Проголосовали: ${votes.cast} / ${votes.total_expected}`
              : 'Ожидание других игроков...'}
          </p>
          <ProgressBar value={progressValue} variant="votes" />
        </div>
      </div>
    );
  }

  return (
    <div className="day-voting">
      <AmbientBackground variant="voting" />

      <GameScreenHeader
        title="Голосование"
        timer={<Timer seconds={timeLeft} dangerThreshold={10} />}
        showRulesButton
      />

      {votes && (
        <div className="day-voting__vote-counter">
          Проголосовали: {votes.cast} / {votes.total_expected}
        </div>
      )}

      {isBlocked && (
        <div className="day-voting__blocked-notice">
          Вы не можете голосовать в этом раунде
        </div>
      )}

      {myStatus === 'dead' && (
        <div className="day-voting__spectator-notice">
          Вы наблюдаете за голосованием
        </div>
      )}

      <div className="day-voting__targets">
        {availableTargets.map((target) => {
          const isSelected = selectedTarget === target.player_id;
          return (
            <SelectableCard
              key={target.player_id}
              state={isSelected ? 'selected' : 'default'}
              disabled={!canVote}
              onClick={() => canVote && setSelectedTarget(target.player_id)}
              rightSlot={isSelected ? <span className="day-voting__target-check"><CheckIcon /></span> : null}
            >
              <span className="day-voting__target-info">
                <span className="day-voting__target-name">{target.name}</span>
                {target.username && (
                  <span className="day-voting__target-nickname">{target.username}</span>
                )}
              </span>
            </SelectableCard>
          );
        })}
      </div>

      <div className="day-voting__actions">
        <button
          className="day-voting__confirm"
          disabled={!selectedTarget || !canVote || submitting}
          onClick={handleConfirmVote}
        >
          Подтвердить
        </button>
        <button
          className="day-voting__skip"
          disabled={!canVote || submitting}
          onClick={handleSkipVote}
        >
          Пропустить голос
        </button>
      </div>
    </div>
  );
}
