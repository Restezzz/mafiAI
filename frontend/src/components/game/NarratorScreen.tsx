import React, { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../../stores/gameStore';
import { useNarrationAudio } from '../../hooks/useNarrationAudio';
import AmbientBackground from '../ui/AmbientBackground';
import ProgressBar from '../ui/ProgressBar';
import { serverNow } from '../../utils/serverClock';
import './NarratorScreen.scss';

// Дефолтный шаг — используется только если нет duration_ms у announcement
// (т.е. text-only fallback без аудио).
const DEFAULT_CHAR_INTERVAL_MS = 45;
const TICK_INTERVAL_MS = 45;

function getStartedAtMs(startedAtIso?: string): number | null {
  if (!startedAtIso) return null;
  const ts = Date.parse(startedAtIso);
  return Number.isFinite(ts) ? ts : null;
}

function getCharInterval(textLen: number, durationMs: number | undefined): number {
  // Если есть длительность аудио — растягиваем typewriter ровно на это время.
  // textLen=0 защищаемся от деления на 0.
  if (durationMs && durationMs > 0 && textLen > 0) {
    return durationMs / textLen;
  }
  return DEFAULT_CHAR_INTERVAL_MS;
}

function computeDisplayedChars(textLen: number, startedAtMs: number | null, now: number, durationMs: number | undefined): number {
  if (textLen <= 0) return 0;
  if (startedAtMs === null) {
    // Нет server-time — fallback на «начать с 0 при mount».
    return 0;
  }
  const elapsedMs = Math.max(0, now - startedAtMs);
  const charInterval = getCharInterval(textLen, durationMs);
  return Math.min(textLen, Math.floor(elapsedMs / charInterval));
}

function computeProgress(durationMs: number | undefined, startedAtMs: number | null, textLen: number, displayedChars: number, now: number): number {
  if (startedAtMs !== null && durationMs && durationMs > 0) {
    const elapsedMs = Math.max(0, now - startedAtMs);
    return Math.min(100, (elapsedMs / durationMs) * 100);
  }
  if (textLen <= 0) return 0;
  return Math.min(100, (displayedChars / textLen) * 100);
}

export default function NarratorScreen() {
  const announcement = useGameStore((s) => s.currentAnnouncement);
  const { needsGesture } = useNarrationAudio(announcement);
  const currentText = announcement?.text ?? '';
  const announcementKey = announcement?.key ?? currentText;
  const startedAtMs = getStartedAtMs(announcement?.started_at);
  const durationMs = announcement?.duration_ms;

  // Сразу при mount/смене announcement — догоняем то место, где должен быть typewriter
  // согласно server-time. Это синхронизирует разные клиенты и refresh-нутые вкладки.
  const [displayedChars, setDisplayedChars] = useState(() =>
    computeDisplayedChars(currentText.length, startedAtMs, serverNow(), durationMs)
  );
  const [progress, setProgress] = useState(() =>
    computeProgress(
      durationMs,
      startedAtMs,
      currentText.length,
      computeDisplayedChars(currentText.length, startedAtMs, serverNow(), durationMs),
      serverNow(),
    )
  );
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // При смене announcement пересчитать «откуда продолжать».
  useEffect(() => {
    const next = computeDisplayedChars(currentText.length, startedAtMs, serverNow(), durationMs);
    setDisplayedChars(next);
    setProgress(computeProgress(durationMs, startedAtMs, currentText.length, next, serverNow()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcementKey]);

  useEffect(() => {
    if (!currentText) return undefined;

    const tick = () => {
      const now = serverNow();
      const nextChars = computeDisplayedChars(currentText.length, startedAtMs, now, durationMs);
      setDisplayedChars((prev) => (nextChars > prev ? nextChars : prev));
      setProgress(computeProgress(durationMs, startedAtMs, currentText.length, nextChars, now));
      const allDone =
        nextChars >= currentText.length &&
        (!startedAtMs || !durationMs || now - startedAtMs >= durationMs);
      if (allDone && tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };

    tickRef.current = setInterval(tick, TICK_INTERVAL_MS);
    // Первый tick сразу — без ожидания interval'а.
    tick();

    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [announcementKey, currentText, startedAtMs, durationMs]);

  return (
    <div className="narrator-screen">
      <AmbientBackground variant="narrator" />

      <ProgressBar value={progress} variant="narrator" />

      <div className="narrator-screen__content">
        <div className="narrator-screen__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </div>

        <div className="narrator-screen__text-container">
          <p className="narrator-screen__text">
            {currentText.split('').map((char, i) => (
              <span
                key={`${announcement?.key ?? 'announcement'}-${i}`}
                className={`narrator-char ${i < displayedChars ? 'narrator-char--visible' : ''}`}
              >
                {char}
              </span>
            ))}
          </p>
        </div>

        <div className="narrator-screen__hint">Ведущий продолжает сценарий...</div>

        {announcement?.steps_total && announcement.steps_total > 1 && (
          <div className="narrator-screen__counter">
            {announcement.step_index ?? 1} / {announcement.steps_total}
          </div>
        )}
      </div>

      {needsGesture && (
        <button
          type="button"
          className="narrator-screen__gesture-prompt"
          onClick={() => {
            /* любой жест ловится глобальным listener'ом — клик по этой кнопке тоже */
          }}
          aria-label="Включить озвучку"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M19 12c0-2.5-1.5-4.5-3-5.5" />
            <path d="M22 12c0-4-2.5-7-5-8.5" />
          </svg>
          <span>Нажмите чтобы включить озвучку</span>
        </button>
      )}
    </div>
  );
}
