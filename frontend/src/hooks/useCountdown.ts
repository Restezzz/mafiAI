import { useEffect, useRef, useState } from 'react';
import { serverNow } from '../utils/serverClock';

export interface CountdownConfig {
  enabled?: boolean;
  paused?: boolean;
  timerSeconds?: number | null;
  timerStartedAt?: string | null;
  fallbackSeconds: number;
  resetKey?: string | number | null;
}

export function computeRemainingSeconds(
  timerSeconds: number | null | undefined,
  timerStartedAt: string | null | undefined,
  fallbackSeconds: number,
): number {
  if (!timerSeconds) return fallbackSeconds;
  if (!timerStartedAt) return timerSeconds;

  const startedMs = Date.parse(timerStartedAt);
  if (Number.isNaN(startedMs)) {
    return timerSeconds;
  }

  // serverNow() = Date.now() + offset. offset обновляется через
  // updateOffsetFromServerNow в wsClient на каждый incoming WS frame.
  // Без этого при skew >1с (наблюдалось +25с на проде VPS) elapsed=0
  // и таймер замерзает на полную длительность skew, пока клиентские
  // часы не догонят.
  const elapsed = Math.max(0, Math.floor((serverNow() - startedMs) / 1000));
  return Math.max(0, timerSeconds - elapsed);
}

export function useCountdown({
  enabled = true,
  paused = false,
  timerSeconds,
  timerStartedAt,
  fallbackSeconds,
  resetKey,
}: CountdownConfig): number {
  const [timeLeft, setTimeLeft] = useState(() =>
    computeRemainingSeconds(timerSeconds, timerStartedAt, fallbackSeconds)
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // При смене ключевых пропов сразу пересчитываем remaining из server-time.
  useEffect(() => {
    setTimeLeft(computeRemainingSeconds(timerSeconds, timerStartedAt, fallbackSeconds));
  }, [fallbackSeconds, resetKey, timerSeconds, timerStartedAt]);

  useEffect(() => {
    if (!enabled || paused) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Пересчёт каждый tick от server-time, а не локальный декремент. Это убирает
    // дрейф между клиентами, корректно отрабатывает невидимую вкладку (throttled
    // setInterval) и сразу показывает актуальное значение после reload.
    intervalRef.current = setInterval(() => {
      const next = computeRemainingSeconds(timerSeconds, timerStartedAt, fallbackSeconds);
      setTimeLeft((current) => (current === next ? current : next));
      if (next <= 0 && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, paused, timerSeconds, timerStartedAt, fallbackSeconds]);

  return timeLeft;
}
