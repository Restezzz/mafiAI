import React, { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../../utils/constants';

interface Props {
  /** Относительный URL из API (например, /audio/.../foo.mp3) — будет префиксован API_BASE_URL. */
  url: string | null;
  /** Опциональная подпись (имя файла), показывается слева. */
  label?: string | null;
  /** Размер: small используется в плотных списках. */
  size?: 'small' | 'medium';
}

/**
 * Минималистичный плеер mp3 для админ-панели. Не использует <audio controls>,
 * чтобы держать единый внешний вид. На single-play тогглит между play/pause.
 *
 * Не управляет глобальным аудио-стейтом — если в админке параллельно играют
 * два плеера, оба будут воспроизводиться. Это приемлемо для тулинга
 * (админ просто остановит лишний руками).
 */
export default function AudioPlayer({ url, label, size = 'medium' }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  // Если url меняется (например, после замены аудио в варианте) — сбрасываем плеер.
  useEffect(() => {
    setIsPlaying(false);
    setProgress(0);
    setDuration(0);
  }, [url]);

  if (!url) {
    return (
      <span style={{ color: '#8c8f95', fontSize: size === 'small' ? '0.78rem' : '0.85rem' }}>
        нет аудио
      </span>
    );
  }

  const fullUrl = `${API_BASE_URL}${url}`;

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {
        // autoplay-policy: первое касание разрешает воспроизведение
      });
    } else {
      audio.pause();
    }
  };

  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);
  const handleEnded = () => {
    setIsPlaying(false);
    setProgress(0);
  };
  const handleTimeUpdate = () => {
    const a = audioRef.current;
    if (!a) return;
    setProgress(a.currentTime);
  };
  const handleLoadedMetadata = () => {
    const a = audioRef.current;
    if (!a) return;
    setDuration(a.duration);
  };

  const formatTime = (s: number) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const small = size === 'small';
  const btnSize = small ? 24 : 30;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: small ? '2px 8px 2px 4px' : '4px 10px 4px 4px',
        background: '#0d0e10',
        border: '1px solid #2a2c30',
        borderRadius: small ? 14 : 18,
        fontSize: small ? '0.75rem' : '0.82rem',
        color: '#e8e8ea',
        maxWidth: '100%',
      }}
    >
      <button
        onClick={toggle}
        style={{
          width: btnSize,
          height: btnSize,
          borderRadius: '50%',
          border: 'none',
          background: isPlaying ? '#c81e1e' : '#2a2c30',
          color: '#fff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        type="button"
        aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}
      >
        {isPlaying ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" />
            <rect x="14" y="5" width="4" height="14" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6,4 20,12 6,20" />
          </svg>
        )}
      </button>
      {label && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {label}
        </span>
      )}
      {duration > 0 && (
        <span style={{ color: '#8c8f95', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {formatTime(progress)} / {formatTime(duration)}
        </span>
      )}
      <audio
        ref={audioRef}
        src={fullUrl}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={handleEnded}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        preload="metadata"
      />
    </div>
  );
}
