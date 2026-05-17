import { useEffect, useRef, useState } from 'react';
import { useAudioStore } from '../stores/audioStore';
import type { Announcement, AudioSegment } from '../types/game';
import { resolvePreloadedAudioUrl } from '../utils/audioPreloader';

const HAVE_FUTURE_DATA = 3;
const PLAYABLE_WAIT_TIMEOUT_MS = 2500;

/**
 * Воспроизведение аудио озвучки для announcement, синхронизованное по
 * server-time (`started_at`).
 *
 * Принципы:
 * - При каждом фактическом старте сегмента (loadedmetadata, retry после
 *   жеста, onEnded) пересчитываем `(index, offsetMs)` из текущего
 *   `Date.now() - startedAtMs`, а не из снимка на момент создания эффекта.
 *   Это закрывает дрейф из-за autoplay-wait и задержки `loadedmetadata`.
 * - Раз в ~500мс drift-loop проверяет, что `audio.currentTime` совпадает
 *   с серверным `expected`, и при расхождении >250мс делает seek/skip.
 * - На unmount/смену announcement — пауза + сброс src.
 *
 * Возвращает имя текущего файла, индекс активного сегмента и флаг
 * блокировки autoplay.
 */
export function useNarrationAudio(announcement: Announcement | null) {
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  // true пока браузер блокирует autoplay и мы ждём первого жеста пользователя.
  const [needsGesture, setNeedsGesture] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const muted = useAudioStore((s) => s.muted);
  const volume = useAudioStore((s) => s.volume);

  const announcementKey = announcement?.key ?? null;

  // Реактивно прокидываем mute / volume в активный аудио-элемент.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.muted = muted;
    a.volume = volume;
  }, [muted, volume]);

  // Каждый раз когда меняется announcement.key — стартуем заново.
  useEffect(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        /* noop */
      }
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setCurrentSegmentIndex(-1);
    setCurrentFileName(null);
    setNeedsGesture(false);

    if (!announcement) return;
    const segments = resolveSegments(announcement);
    if (segments.length === 0) return;

    const startedAtMs = announcement.started_at ? Date.parse(announcement.started_at) : NaN;

    // Если уже на старте позиция за пределами всех сегментов — ничего не играем.
    const initial = pickPosition(segments, startedAtMs, Date.now());
    if (!initial) return;

    const audio = new Audio();
    audio.preload = 'auto';
    const audioState = useAudioStore.getState();
    audio.muted = audioState.muted;
    audio.volume = audioState.volume;
    audioRef.current = audio;

    let currentIndex = initial.index;
    let cancelled = false;
    let gestureCleanup: (() => void) | null = null;
    let driftTimer: ReturnType<typeof setInterval> | null = null;
    // Поколение «текущего src». Каждый playFrom инкрементирует и фиксирует
    // в свою closure через myGen. Если drift-loop / onEnded / gesture-retry
    // успели вызвать playFrom второй раз, пока loadedmetadata от первого ещё
    // не пришёл, оба seekAndPlay нацелены на разные segments[idx], и нельзя
    // позволить старому отработать поверх нового src.
    let loadGeneration = 0;

    const stopDriftLoop = () => {
      if (driftTimer) {
        clearInterval(driftTimer);
        driftTimer = null;
      }
    };

    const startDriftLoop = () => {
      stopDriftLoop();
      // Без валидного startedAtMs нет серверного эталона — drift-loop
      // некорректен (pickPosition всегда вернёт {0,0} и мы будем перематывать
      // в начало). Просто играем естественно через onEnded → idx+1.
      if (!Number.isFinite(startedAtMs)) return;
      // Раз в 500мс сравниваем audio.currentTime с серверным expected.
      // При расхождении >250мс — seek; если elapsed ушёл за пределы текущего
      // сегмента — переходим к актуальному (или останавливаемся, если всё
      // отзвучало по серверу).
      driftTimer = setInterval(() => {
        if (cancelled) return;
        if (audio.paused || audio.seeking || audio.readyState < HAVE_FUTURE_DATA) return;
        const pos = pickPosition(segments, startedAtMs, Date.now());
        if (!pos) {
          stopDriftLoop();
          try { audio.pause(); } catch { /* noop */ }
          setCurrentSegmentIndex(-1);
          setCurrentFileName(null);
          return;
        }
        if (pos.index !== currentIndex) {
          // Серверное время ушло на следующий сегмент — переключаемся.
          playFrom(pos.index, pos.offsetMs);
          return;
        }
        const expectedSec = pos.offsetMs / 1000;
        const drift = audio.currentTime - expectedSec;
        if (Math.abs(drift) > 0.25) {
          try {
            audio.currentTime = expectedSec;
          } catch {
            /* noop — некоторые браузеры могут бросить, переживём */
          }
        }
      }, 500);
    };

    const attachGestureRetry = () => {
      // Браузерный autoplay-policy блокирует play() без user-gesture.
      // Ждём первого жеста, затем пересчитываем позицию (за время ожидания
      // server-time мог уйти на десятки секунд) и ретраим.
      setNeedsGesture(true);
      const cleanup = () => {
        document.removeEventListener('click', retry);
        document.removeEventListener('keydown', retry);
        document.removeEventListener('touchstart', retry);
        document.removeEventListener('pointerdown', retry);
      };
      const retry = () => {
        cleanup();
        gestureCleanup = null;
        if (cancelled) return;
        setNeedsGesture(false);
        const pos = pickPosition(segments, startedAtMs, Date.now());
        if (!pos) {
          // Пока ждали жеста, всё уже отзвучало по серверу — не играем.
          setCurrentSegmentIndex(-1);
          setCurrentFileName(null);
          return;
        }
        // Если за время ожидания мы ушли на следующий сегмент — переключаемся,
        // иначе просто переставляем currentTime и снова пытаемся play().
        if (pos.index !== currentIndex) {
          playFrom(pos.index, pos.offsetMs);
        } else {
          try {
            audio.currentTime = pos.offsetMs / 1000;
          } catch {
            /* noop */
          }
          const p = audio.play();
          if (p && typeof p.catch === 'function') {
            p.catch((retryErr) => {
              console.warn('[narration audio] retry after gesture failed:', retryErr);
            });
          }
          startDriftLoop();
        }
      };
      document.addEventListener('click', retry, { once: true });
      document.addEventListener('keydown', retry, { once: true });
      document.addEventListener('touchstart', retry, { once: true });
      document.addEventListener('pointerdown', retry, { once: true });
      gestureCleanup = cleanup;
    };

    const playFrom = (idx: number, fallbackOffsetMs: number) => {
      if (cancelled) return;
      stopDriftLoop();
      if (idx >= segments.length) {
        setCurrentSegmentIndex(-1);
        setCurrentFileName(null);
        return;
      }
      const myGen = ++loadGeneration;
      currentIndex = idx;
      setCurrentSegmentIndex(idx);
      setCurrentFileName(extractFileName(segments[idx].url));

      audio.src = resolvePreloadedAudioUrl(segments[idx].url);

      const isStale = () => cancelled || myGen !== loadGeneration;

      const seekAndPlay = async () => {
        if (isStale()) return;
        let offsetMs = fallbackOffsetMs;
        // Пересчитываем offset «здесь и сейчас» — за время load() могло
        // уйти 100мс+ (HMR throttling, Safari tab throttling и т.п.).
        // Если startedAtMs невалиден — нет серверного эталона, играем с
        // fallbackOffsetMs (обычно 0 для последующих сегментов).
        if (Number.isFinite(startedAtMs)) {
          const pos = pickPosition(segments, startedAtMs, Date.now());
          if (pos && pos.index === idx) {
            offsetMs = pos.offsetMs;
          } else if (pos && pos.index !== idx) {
            // Сервер уже на следующем сегменте — перепрыгиваем туда.
            playFrom(pos.index, pos.offsetMs);
            return;
          } else if (!pos) {
            // Всё уже отзвучало.
            setCurrentSegmentIndex(-1);
            setCurrentFileName(null);
            return;
          }
        }
        if (offsetMs > 0) {
          try {
            audio.currentTime = offsetMs / 1000;
          } catch {
            /* noop */
          }
        }
        await waitForPlayable(audio, isStale);
        if (isStale()) return;
        if (Number.isFinite(startedAtMs)) {
          const pos = pickPosition(segments, startedAtMs, Date.now());
          if (pos && pos.index === idx) {
            offsetMs = pos.offsetMs;
            try {
              audio.currentTime = offsetMs / 1000;
            } catch {
              /* noop */
            }
          } else if (pos && pos.index !== idx) {
            playFrom(pos.index, pos.offsetMs);
            return;
          } else if (!pos) {
            setCurrentSegmentIndex(-1);
            setCurrentFileName(null);
            return;
          }
        }
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => {
            if (isStale()) return;
            // AbortError — это нормальный side-effect, когда мы успели
            // заменить src (drift-skip к следующему сегменту, новый
            // playFrom от onEnded и т.п.). НЕ показываем gesture-prompt.
            // NotAllowedError — реальная блокировка autoplay браузером.
            const name = err && (err as { name?: string }).name;
            if (name === 'AbortError') return;
            console.warn('[narration audio] play() rejected, awaiting user gesture:', err);
            attachGestureRetry();
          });
        }
        startDriftLoop();
      };

      // loadedmetadata нужен и для seek, и для того, чтобы offset был
      // достоверным (audio.duration становится известной).
      const onMetaLoaded = () => {
        if (isStale()) return;
        seekAndPlay();
      };
      audio.addEventListener('loadedmetadata', onMetaLoaded, { once: true });
      audio.load();
    };

    const onEnded = () => {
      if (cancelled) return;
      // Без серверного эталона переходим на следующий сегмент по порядку.
      // С эталоном — пересчитываем актуальную позицию и пропускаем
      // промежуточные сегменты, если сервер уже ушёл дальше.
      if (!Number.isFinite(startedAtMs)) {
        playFrom(currentIndex + 1, 0);
        return;
      }
      const pos = pickPosition(segments, startedAtMs, Date.now());
      if (!pos) {
        setCurrentSegmentIndex(-1);
        setCurrentFileName(null);
        return;
      }
      playFrom(pos.index, pos.offsetMs);
    };

    audio.addEventListener('ended', onEnded);

    playFrom(initial.index, initial.offsetMs);

    return () => {
      cancelled = true;
      stopDriftLoop();
      if (gestureCleanup) {
        gestureCleanup();
        gestureCleanup = null;
      }
      audio.removeEventListener('ended', onEnded);
      try {
        audio.pause();
      } catch {
        /* noop */
      }
      audio.src = '';
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcementKey]);

  return {
    currentSegmentIndex,
    currentFileName,
    needsGesture,
  };
}

/**
 * Вычисляет активный сегмент и offset внутри него на момент `now`,
 * исходя из `startedAtMs` (UNIX ms) и списка сегментов с duration_ms.
 *
 * - Если `startedAtMs` невалиден (NaN) — играем с самого начала первого
 *   сегмента: `{index: 0, offsetMs: 0}`.
 * - Если `now < startedAtMs` (clock skew) — тоже с начала.
 * - Если `now >= startedAtMs + sum(duration_ms)` — возвращает `null`,
 *   т.е. всё уже отзвучало.
 *
 * Чистая функция — экспортируется для юнит-тестов.
 */
export function pickPosition(
  segments: AudioSegment[],
  startedAtMs: number,
  now: number,
): { index: number; offsetMs: number } | null {
  if (segments.length === 0) return null;
  if (!Number.isFinite(startedAtMs)) {
    return { index: 0, offsetMs: 0 };
  }
  const elapsedMs = now - startedAtMs;
  if (elapsedMs <= 0) {
    return { index: 0, offsetMs: 0 };
  }
  let acc = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const dur = Math.max(0, segments[i].duration_ms || 0);
    if (elapsedMs < acc + dur) {
      return { index: i, offsetMs: Math.max(0, elapsedMs - acc) };
    }
    acc += dur;
  }
  return null;
}

function resolveSegments(a: Announcement): AudioSegment[] {
  if (a.audio_segments && a.audio_segments.length > 0) {
    return a.audio_segments;
  }
  if (a.audio_url) {
    return [{ url: a.audio_url, duration_ms: a.duration_ms }];
  }
  return [];
}

function waitForPlayable(audio: HTMLAudioElement, isStale: () => boolean): Promise<void> {
  if (isStale() || audio.readyState >= HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      audio.removeEventListener('canplay', finish);
      audio.removeEventListener('canplaythrough', finish);
      audio.removeEventListener('loadeddata', finish);
      audio.removeEventListener('progress', onProgress);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      resolve();
    };
    const onProgress = () => {
      if (isStale() || audio.readyState >= HAVE_FUTURE_DATA) {
        finish();
      }
    };

    audio.addEventListener('canplay', finish, { once: true });
    audio.addEventListener('canplaythrough', finish, { once: true });
    audio.addEventListener('loadeddata', finish, { once: true });
    audio.addEventListener('progress', onProgress);
    timeoutId = setTimeout(finish, PLAYABLE_WAIT_TIMEOUT_MS);
  });
}

function extractFileName(url: string): string {
  try {
    const decoded = decodeURIComponent(url);
    const parts = decoded.split('/');
    return parts[parts.length - 1] || decoded;
  } catch {
    return url;
  }
}
