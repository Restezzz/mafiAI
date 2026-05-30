/**
 * Экран выбора имени (фаза name_pick).
 *
 * Показывается после голосования за сюжет (story_vote) и до раздачи ролей
 * (role_reveal). Игрок выбирает себе имя из набора имён победившего сюжета
 * (story_names с фолбэком на глобальный каталог). Имена, занятые другими
 * игроками, недоступны. По истечении таймера бэк автоматически добивает
 * незанятые имена и переходит к role_reveal.
 */
import React, { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useGameStore } from '../../stores/gameStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useCountdown } from '../../hooks/useCountdown';
import Timer from '../ui/Timer';
import Button from '../ui/Button';
import GameScreenHeader from './GameScreenHeader';
import { getApiErrorMessage } from '../../utils/getApiErrorMessage';
import './NamePickScreen.scss';

const NAME_PICK_FALLBACK_SECONDS = 60;

export default function NamePickScreen() {
  const namePick = useGameStore((s) => s.namePick);
  const phase = useGameStore((s) => s.phase);
  const submitted = useGameStore((s) => s.namePickSubmitted);
  const submitNamePick = useGameStore((s) => s.submitNamePick);
  const myPlayerId = useGameStore((s) => s.myPlayerId);
  // Имена в реальном времени занимаются другими игроками — берём из общего
  // ростера сессии (обновляется по WS player_renamed), плюс серверный снапшот.
  const players = useSessionStore((s) => s.players);
  const timerPaused = useSessionStore((s) => s.timerPaused);

  // На реконнекте my_name может быть лобби-плейсхолдером («Игрок 3»), которого
  // нет в наборе имён сюжета — тогда ничего не предвыбираем (иначе кнопка
  // «Подтвердить» активна и submit падает с 404 name_not_allowed).
  const [selected, setSelected] = useState<string | null>(() => {
    const initial = namePick?.my_name ?? null;
    return initial && (namePick?.names ?? []).some((n) => n.display === initial)
      ? initial
      : null;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timeLeft = useCountdown({
    enabled: true,
    paused: timerPaused,
    timerSeconds: phase?.timer_seconds ?? null,
    timerStartedAt: phase?.timer_started_at ?? null,
    fallbackSeconds: NAME_PICK_FALLBACK_SECONDS,
    resetKey: phase?.id ?? null,
  });

  const names = namePick?.names ?? [];
  const myName = namePick?.my_name ?? null;

  const taken = useMemo(() => {
    const set = new Set<string>(namePick?.taken ?? []);
    for (const p of players) {
      if (p.id !== myPlayerId && p.name) set.add(p.name);
    }
    set.delete(myName ?? '');
    return set;
  }, [namePick?.taken, players, myPlayerId, myName]);

  const handleConfirm = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitNamePick(selected);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="name-pick">
      <GameScreenHeader
        title="Выбор имени"
        showPause
        showCharacterName={false}
        timer={<Timer seconds={timeLeft} dangerThreshold={5} />}
      />

      <main className="name-pick__main">
        <p className="name-pick__hint">
          Выберите имя своего персонажа и нажмите «Подтвердить». Не успеете —
          имя выберется автоматически.
        </p>

        <div className="name-pick__grid">
          {names.map((n) => {
            const isTaken = taken.has(n.display);
            const isSelected = selected === n.display;
            const isMine = myName === n.display;
            return (
              <button
                type="button"
                key={n.display}
                className={
                  'name-pick__card' +
                  (isSelected ? ' name-pick__card--selected' : '') +
                  (isTaken ? ' name-pick__card--taken' : '')
                }
                disabled={isTaken || submitted}
                onClick={() => !submitted && !isTaken && setSelected(n.display)}
              >
                <span className="name-pick__card-name">{n.display}</span>
                {n.gender && (
                  <span className="name-pick__card-gender">
                    {n.gender === 'f' ? 'ж' : 'м'}
                  </span>
                )}
                {(isSelected || isMine) && (
                  <span className="name-pick__card-check">
                    <Check size={16} />
                  </span>
                )}
                {isTaken && <span className="name-pick__card-tag">занято</span>}
              </button>
            );
          })}
        </div>

        {names.length === 0 && (
          <p className="name-pick__empty">Нет доступных имён…</p>
        )}
      </main>

      <footer className="name-pick__footer">
        {error && <p className="name-pick__error">{error}</p>}
        <Button
          loading={submitting}
          disabled={!selected || submitting || submitted}
          onClick={handleConfirm}
        >
          {submitted ? 'Имя выбрано' : 'Подтвердить выбор'}
        </Button>
      </footer>
    </div>
  );
}
