import audioManifest from '../data/audioManifest.json';
import { API_BASE_URL } from './constants';

type ManifestName = {
  intro_audio?: string;
};

type ManifestVariant = {
  audio_url?: string;
};

type ManifestPair = {
  opener?: ManifestVariant;
  closer?: ManifestVariant;
};

type ManifestTrigger = {
  variants?: ManifestVariant[];
  pairs?: ManifestPair[];
};

type AudioManifestShape = {
  version?: string;
  names?: ManifestName[];
  triggers?: Record<string, ManifestTrigger>;
};

export type AudioPreloadProgress = {
  total: number;
  loaded: number;
  failed: number;
  done: boolean;
};

export type AudioPreloadResult = AudioPreloadProgress & {
  manifestVersion: string;
};

const MANIFEST = audioManifest as AudioManifestShape;
const AUDIO_URLS = collectAudioUrls(MANIFEST);
const loadedUrls = new Set<string>();
const failedUrls = new Set<string>();
const blobUrls = new Map<string, string>();
const listeners = new Set<(progress: AudioPreloadProgress) => void>();

let preloadPromise: Promise<AudioPreloadResult> | null = null;
let currentProgress: AudioPreloadProgress = {
  total: AUDIO_URLS.length,
  loaded: 0,
  failed: 0,
  done: AUDIO_URLS.length === 0,
};

export const AUDIO_PRELOAD_MANIFEST_VERSION = MANIFEST.version ?? 'unknown';

export function collectAudioUrls(manifest: AudioManifestShape): string[] {
  const urls = new Set<string>();
  for (const name of manifest.names ?? []) {
    if (name.intro_audio) urls.add(name.intro_audio);
  }
  for (const trigger of Object.values(manifest.triggers ?? {})) {
    for (const variant of trigger.variants ?? []) {
      if (variant.audio_url) urls.add(variant.audio_url);
    }
    for (const pair of trigger.pairs ?? []) {
      if (pair.opener?.audio_url) urls.add(pair.opener.audio_url);
      if (pair.closer?.audio_url) urls.add(pair.closer.audio_url);
    }
  }
  return Array.from(urls);
}

export function getNarrationAudioUrls(): string[] {
  return AUDIO_URLS;
}

export function getAudioPreloadProgress(): AudioPreloadProgress {
  return currentProgress;
}

export function resolvePreloadedAudioUrl(url: string): string {
  const blob = blobUrls.get(url);
  if (blob) return blob;
  // Не предзагруженный файл (story-scoped озвучка из админки, напр.
  // /audio/uploads/<uuid>.mp3 — её нет в audioManifest.json). Относительный
  // /audio/... резолвится против origin фронта (CRA dev :3000 / frontend-nginx),
  // где лежат ТОЛЬКО seed-файлы из public/audio. Загруженные через админку файлы
  // живут в backend storage (/app/audio_storage) и отдаются бэкендом на /audio/*.
  // Префиксуем API_BASE_URL — ровно как админский AudioPlayer (audio-элемент
  // умеет играть cross-origin без CORS). Без этого uploads/ давали 404 и тишину.
  if (url.startsWith('/audio/')) {
    return `${API_BASE_URL}${url}`;
  }
  return url;
}

export function subscribeAudioPreload(listener: (progress: AudioPreloadProgress) => void): () => void {
  listeners.add(listener);
  listener(currentProgress);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Освобождает все созданные blob: URL'ы и сбрасывает кэш предзагрузки.
 * После вызова preloadNarrationAudio() начнёт загрузку с нуля.
 *
 * Использовать при logout / при долгом простое — иначе blob'ы держатся в
 * памяти браузера до полной перезагрузки страницы. Между сессиями одного
 * пользователя кэш чистить не надо: озвучка переиспользуется.
 */
export function clearAudioPreloadCache(): void {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    blobUrls.forEach((blobUrl) => {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* noop — браузер мог уже освободить blob сам */
      }
    });
  }
  blobUrls.clear();
  loadedUrls.clear();
  failedUrls.clear();
  preloadPromise = null;
  currentProgress = {
    total: AUDIO_URLS.length,
    loaded: 0,
    failed: 0,
    done: AUDIO_URLS.length === 0,
  };
  emitProgress();
}

export function preloadNarrationAudio(): Promise<AudioPreloadResult> {
  if (preloadPromise) {
    return preloadPromise;
  }

  preloadPromise = (async () => {
    if (AUDIO_URLS.length === 0 || typeof fetch !== 'function') {
      currentProgress = {
        total: AUDIO_URLS.length,
        loaded: AUDIO_URLS.length,
        failed: 0,
        done: true,
      };
      emitProgress();
      return result();
    }

    await runWithConcurrency(AUDIO_URLS, 4, async (url) => {
      if (loadedUrls.has(url)) {
        updateProgress();
        return;
      }
      try {
        const blob = await fetchAudio(url);
        const blobUrl = createBlobUrl(blob);
        if (blobUrl) {
          blobUrls.set(url, blobUrl);
        }
        loadedUrls.add(url);
      } catch {
        failedUrls.add(url);
      } finally {
        updateProgress();
      }
    });

    currentProgress = {
      total: AUDIO_URLS.length,
      loaded: loadedUrls.size,
      failed: failedUrls.size,
      done: true,
    };
    emitProgress();
    return result();
  })();

  return preloadPromise;
}

async function fetchAudio(url: string): Promise<Blob> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`Audio preload failed: ${response.status}`);
      }
      return await response.blob();
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await wait(300);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Audio preload failed');
}

function createBlobUrl(blob: Blob): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  return URL.createObjectURL(blob);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

function updateProgress(): void {
  currentProgress = {
    total: AUDIO_URLS.length,
    loaded: loadedUrls.size,
    failed: failedUrls.size,
    done: loadedUrls.size + failedUrls.size >= AUDIO_URLS.length,
  };
  emitProgress();
}

function emitProgress(): void {
  listeners.forEach((listener) => listener(currentProgress));
}

function result(): AudioPreloadResult {
  return {
    ...currentProgress,
    manifestVersion: AUDIO_PRELOAD_MANIFEST_VERSION,
  };
}
