import React, { useEffect, useRef, useState } from 'react';
import { useNarrationAudio } from '../../hooks/useNarrationAudio';
import type { Announcement } from '../../types/game';
import { serverNow } from '../../utils/serverClock';
import './MiniNarrator.scss';

// Дефолт — для text-only fallback (без аудио). Когда есть duration_ms,
// шаг рассчитывается так, чтобы typewriter завершился ровно с аудио.
const DEFAULT_CHAR_INTERVAL_MS = 45;
const TICK_INTERVAL_MS = 45;

function getCharInterval(textLen: number, durationMs: number | undefined): number {
  if (durationMs && durationMs > 0 && textLen > 0) return durationMs / textLen;
  return DEFAULT_CHAR_INTERVAL_MS;
}

interface Props {
  announcement: Announcement | null;
}

/**
 * Мини-версия NarratorScreen для превью в /ui и админских инструментов.
 * Рисует typewriter-текст + прогресс-бар, синхронизированные с server-time
 * (`announcement.started_at`), и параллельно проигрывает аудио через
 * useNarrationAudio (mute/volume управляется глобальным AudioControls).
 *
 * Без полноэкранного оверлея — компактный блок, который можно вставить
 * в любую карточку.
 */
function computeChars(textLen: number, startedAtMs: number | null, now: number, durationMs: number | undefined): number {
  if (textLen <= 0 || startedAtMs === null || !Number.isFinite(startedAtMs)) return 0;
  const elapsed = Math.max(0, now - startedAtMs);
  return Math.min(textLen, Math.floor(elapsed / getCharInterval(textLen, durationMs)));
}

function computeProgressPct(textLen: number, startedAtMs: number | null, now: number, durationMs: number | undefined, chars: number): number {
  const validStarted = startedAtMs !== null && Number.isFinite(startedAtMs);
  const elapsed = validStarted ? Math.max(0, now - startedAtMs) : 0;
  if (durationMs && durationMs > 0) return Math.min(100, (elapsed / durationMs) * 100);
  if (textLen > 0) return Math.min(100, (chars / textLen) * 100);
  return 0;
}

export default function MiniNarrator({ announcement }: Props) {
  useNarrationAudio(announcement);
  const text = announcement?.text ?? '';
  const startedAtMs = announcement?.started_at ? Date.parse(announcement.started_at) : null;
  const durationMs = announcement?.duration_ms;
  const announcementKey = announcement?.key ?? null;

  // Lazy initializer: на mount/reconnect стартуем с уже корректной позиции,
  // чтобы не было кадра с "0 chars" перед первым tick.
  const [displayedChars, setDisplayedChars] = useState(() =>
    computeChars(text.length, startedAtMs, serverNow(), durationMs)
  );
  const [progress, setProgress] = useState(() =>
    computeProgressPct(
      text.length,
      startedAtMs,
      serverNow(),
      durationMs,
      computeChars(text.length, startedAtMs, serverNow(), durationMs),
    )
  );
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Пересчёт при смене announcement.key — догоняем текущую позицию.
  useEffect(() => {
    const now = serverNow();
    const chars = computeChars(text.length, startedAtMs, now, durationMs);
    setDisplayedChars(chars);
    setProgress(computeProgressPct(text.length, startedAtMs, now, durationMs, chars));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcementKey]);

  useEffect(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (!announcementKey || !text) return;

    const tick = () => {
      const now = serverNow();
      const chars = computeChars(text.length, startedAtMs, now, durationMs);
      setDisplayedChars((prev) => (chars > prev ? chars : prev));
      setProgress(computeProgressPct(text.length, startedAtMs, now, durationMs, chars));
      const elapsed = startedAtMs !== null && Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : 0;
      const allDone = chars >= text.length && (!durationMs || elapsed >= durationMs);
      if (allDone && tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };

    tickRef.current = setInterval(tick, TICK_INTERVAL_MS);
    tick();

    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [announcementKey, text, startedAtMs, durationMs]);

  if (!announcement) {
    return (
      <div className="mini-narrator mini-narrator--idle">
        <div className="mini-narrator__hint">Ожидание реплики ведущего…</div>
      </div>
    );
  }

  return (
    <div className="mini-narrator">
      <div className="mini-narrator__progress">
        <div className="mini-narrator__progress-bar" style={{ width: `${progress}%` }} />
      </div>
      <div className="mini-narrator__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </div>
      <p className="mini-narrator__text">
        {text.split('').map((ch, i) => (
          <span
            key={`${announcementKey}-${i}`}
            className={`mini-narrator__char${i < displayedChars ? ' mini-narrator__char--visible' : ''}`}
          >
            {ch}
          </span>
        ))}
      </p>
      {announcement.steps_total && announcement.steps_total > 1 && (
        <div className="mini-narrator__counter">
          {announcement.step_index ?? 1} / {announcement.steps_total}
        </div>
      )}
    </div>
  );
}
