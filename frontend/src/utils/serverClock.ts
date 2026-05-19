/**
 * Компенсация clock skew между клиентом и backend.
 *
 * Проблема: на проде VPS без NTP-синка серверные часы могут опережать
 * клиентские на десятки секунд (наблюдалось +25с). Все time-based фичи
 * на фронте сравнивают серверные ISO-timestamps с `Date.now()`:
 *   - `useCountdown` — таймер фазы
 *   - `useNarrationAudio.pickPosition` — позиция в composite-аудио
 *   - `NarratorScreen` / `MiniNarrator` — typewriter karaoke
 * При skew >1с все эти формулы выдают `Math.max(0, now - server) = 0`,
 * и фичи замерзают на полную длительность skew.
 *
 * Решение: backend в каждое WS-сообщение добавляет `server_now` (UTC ISO).
 * Frontend через `updateOffsetFromServerNow()` пересчитывает offset и
 * экспортирует `serverNow()` — `Date.now() + offsetMs`, что и должно
 * сравниваться с серверными timestamps.
 *
 * Сглаживание: одиночный jitter сети может дать кратковременный неверный
 * sample (RTT 200мс → offset уйдёт на 200мс в одну сторону). Мы храним
 * среднее последних N сэмплов и применяем его, а не последний.
 */

const SAMPLE_WINDOW = 5;

let offsetMs = 0;
let samples: number[] = [];

/**
 * Регистрирует серверный момент (UTC ISO) и обновляет offset.
 * Возвращает текущий усреднённый offset (мс).
 */
export function updateOffsetFromServerNow(serverNowIso: string | undefined | null): number {
  if (!serverNowIso) return offsetMs;
  const serverMs = Date.parse(serverNowIso);
  if (!Number.isFinite(serverMs)) return offsetMs;
  const sample = serverMs - Date.now();
  samples.push(sample);
  if (samples.length > SAMPLE_WINDOW) {
    samples = samples.slice(samples.length - SAMPLE_WINDOW);
  }
  // Среднее — простой способ сгладить network jitter. Медиана была бы точнее,
  // но для 5 сэмплов разница незначима.
  const sum = samples.reduce((acc, v) => acc + v, 0);
  offsetMs = Math.round(sum / samples.length);
  return offsetMs;
}

/**
 * Текущий момент по серверному времени (UTC ms epoch).
 * Если offset ещё не получен — возвращает Date.now() (как и было раньше).
 */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/**
 * Текущий offset в миллисекундах (для дебага/тестов).
 * `>0` — серверные часы опережают клиента, `<0` — отстают.
 */
export function getServerClockOffsetMs(): number {
  return offsetMs;
}

/**
 * Сброс состояния (для тестов).
 */
export function resetServerClock(): void {
  offsetMs = 0;
  samples = [];
}
