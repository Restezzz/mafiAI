/**
 * Экран голосования за сюжет (фича 3).
 *
 * Показывается после запуска игры, если включён новый сюжетный движок и
 * доступно >1 сюжета. Игроки видят карточки сюжетов с обложкой (кадрированной
 * по cover_crop) и кнопкой «i» с описанием. Выбор подтверждается кнопкой снизу.
 * Победитель определяется большинством (ничья → случайный лидер) на бэке.
 */
import React, { useState } from 'react';
import { Info, Check } from 'lucide-react';
import { useGameStore } from '../../stores/gameStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useCountdown } from '../../hooks/useCountdown';
import Timer from '../ui/Timer';
import Button from '../ui/Button';
import GameScreenHeader from './GameScreenHeader';
import { CoverCrop, StoryVoteCard } from '../../types/game';
import { API_BASE_URL } from '../../utils/constants';
import './StoryVoteScreen.scss';

const STORY_VOTE_FALLBACK_SECONDS = 30;

export function coverBackgroundStyle(
  url: string | null,
  crop: CoverCrop | null,
): React.CSSProperties {
  if (!url) return {};
  const image = `url(${API_BASE_URL}${url})`;
  if (!crop) {
    return {
      backgroundImage: image,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    };
  }
  const { x, y, w, h } = crop;
  const sizeX = w > 0 ? 100 / w : 100;
  const sizeY = h > 0 ? 100 / h : 100;
  const posX = w < 1 ? (x / (1 - w)) * 100 : 0;
  const posY = h < 1 ? (y / (1 - h)) * 100 : 0;
  return {
    backgroundImage: image,
    backgroundSize: `${sizeX}% ${sizeY}%`,
    backgroundPosition: `${posX}% ${posY}%`,
    backgroundRepeat: 'no-repeat',
  };
}

function StoryCard({
  card,
  count,
  selected,
  expanded,
  onSelect,
  onToggleInfo,
}: {
  card: StoryVoteCard;
  count: number;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleInfo: () => void;
}) {
  return (
    <div
      className={`story-vote__card${selected ? ' story-vote__card--selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <button
        type="button"
        className="story-vote__info-btn"
        onClick={(e) => {
          e.stopPropagation();
          onToggleInfo();
        }}
        aria-label="Описание сюжета"
      >
        <Info size={22} />
      </button>

      <div
        className="story-vote__cover"
        style={coverBackgroundStyle(card.cover_url, card.cover_crop)}
      >
        {!card.cover_url && (
          <span className="story-vote__cover-placeholder">{card.name}</span>
        )}
        {selected && (
          <span className="story-vote__check">
            <Check size={28} />
          </span>
        )}
      </div>

      <div className="story-vote__card-body">
        <span className="story-vote__card-title">{card.name}</span>
        {count > 0 && <span className="story-vote__card-count">{count}</span>}
      </div>

      {expanded && (
        <div className="story-vote__description" onClick={(e) => e.stopPropagation()}>
          {card.description || 'Описание отсутствует.'}
        </div>
      )}
    </div>
  );
}

export default function StoryVoteScreen() {
  const storyVote = useGameStore((s) => s.storyVote);
  const phase = useGameStore((s) => s.phase);
  const submitted = useGameStore((s) => s.storyVoteSubmitted);
  const myVote = useGameStore((s) => s.storyVoteTarget);
  const submitStoryVote = useGameStore((s) => s.submitStoryVote);
  const timerPaused = useSessionStore((s) => s.timerPaused);

  const [selectedId, setSelectedId] = useState<string | null>(myVote);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timeLeft = useCountdown({
    enabled: true,
    paused: timerPaused,
    timerSeconds: phase?.timer_seconds ?? null,
    timerStartedAt: phase?.timer_started_at ?? null,
    fallbackSeconds: STORY_VOTE_FALLBACK_SECONDS,
    resetKey: phase?.id ?? null,
  });

  const stories = storyVote?.stories ?? [];
  const counts = storyVote?.counts ?? {};
  const voted = storyVote?.voted ?? 0;
  const aliveTotal = storyVote?.alive_total ?? 0;

  const handleConfirm = async () => {
    if (!selectedId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitStoryVote(selectedId);
    } catch {
      setError('Не удалось отправить голос. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="story-vote">
      <GameScreenHeader
        title="Голосование за сюжет"
        showPause={false}
        showCharacterName={false}
        pauseSlot={<span className="story-vote__header-spacer" />}
        timer={<Timer seconds={timeLeft} dangerThreshold={5} />}
      />

      <main className="story-vote__main">
        <p className="story-vote__hint">
          Выберите сюжет и нажмите «Подтвердить». Победит сюжет с большинством
          голосов.
        </p>

        <div className="story-vote__grid">
          {stories.map((card) => (
            <StoryCard
              key={card.id}
              card={card}
              count={counts[card.id] ?? 0}
              selected={selectedId === card.id}
              expanded={expandedId === card.id}
              onSelect={() => !submitted && setSelectedId(card.id)}
              onToggleInfo={() =>
                setExpandedId((prev) => (prev === card.id ? null : card.id))
              }
            />
          ))}
        </div>

        {stories.length === 0 && (
          <p className="story-vote__empty">Нет доступных сюжетов…</p>
        )}
      </main>

      <footer className="story-vote__footer">
        {error && <p className="story-vote__error">{error}</p>}
        <p className="story-vote__progress">
          Проголосовало: {voted}
          {aliveTotal ? ` / ${aliveTotal}` : ''}
        </p>
        <Button
          loading={submitting}
          disabled={!selectedId || submitting || submitted}
          onClick={handleConfirm}
        >
          {submitted ? 'Голос принят' : 'Подтвердить выбор'}
        </Button>
      </footer>
    </div>
  );
}
