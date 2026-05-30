/**
 * Экран голосования за сюжет (фича 3).
 *
 * Показывается после запуска игры, если включён новый сюжетный движок и
 * доступно >1 сюжета. Игроки видят карточки сюжетов с обложкой (кадрированной
 * по cover_crop) и кнопкой «i» с описанием. Выбор подтверждается кнопкой снизу.
 * Победитель определяется большинством (ничья → случайный лидер) на бэке.
 */
import React, { useState } from 'react';
import { Info, Check, X } from 'lucide-react';
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
  onSelect,
  onShowInfo,
}: {
  card: StoryVoteCard;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onShowInfo: () => void;
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
          onShowInfo();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Описание сюжета"
      >
        <Info size={20} />
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
    </div>
  );
}

function StoryInfoModal({
  card,
  onClose,
}: {
  card: StoryVoteCard;
  onClose: () => void;
}) {
  return (
    <div className="story-info-overlay" onClick={onClose}>
      <div
        className="story-info-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Описание сюжета: ${card.name}`}
      >
        <div
          className="story-info-modal__cover"
          style={coverBackgroundStyle(card.cover_url, card.cover_crop)}
        >
          {!card.cover_url && (
            <span className="story-info-modal__cover-placeholder">{card.name}</span>
          )}
          <button
            type="button"
            className="story-info-modal__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>
        <div className="story-info-modal__body">
          <h3 className="story-info-modal__title">{card.name}</h3>
          <p className="story-info-modal__text">
            {card.description || 'Описание отсутствует.'}
          </p>
        </div>
      </div>
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
  const [infoId, setInfoId] = useState<string | null>(null);
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
  const infoCard = stories.find((s) => s.id === infoId) ?? null;

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
        showPause
        showCharacterName={false}
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
              onSelect={() => !submitted && setSelectedId(card.id)}
              onShowInfo={() => setInfoId(card.id)}
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

      {infoCard && (
        <StoryInfoModal card={infoCard} onClose={() => setInfoId(null)} />
      )}
    </div>
  );
}
