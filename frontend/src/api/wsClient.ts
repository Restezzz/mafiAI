import { WS_BASE_URL } from '../utils/constants';
import { useAuthStore } from '../stores/authStore';
import { useSessionStore } from '../stores/sessionStore';
import { useGameStore } from '../stores/gameStore';
import { SessionSettings } from '../types/game';
import { AudioPreloadStatusResponse, PlayerInList } from '../types/api';
import { logger } from '../services/logger';
import { navigateTo } from '../utils/routerRef';
import { updateOffsetFromServerNow } from '../utils/serverClock';

/**
 * Синглтон WebSocket-клиента для игровой сессии.
 *
 * Контракт сообщений: §6 backend_documentation.md. Все игровые действия идут через REST,
 * WS — источник push-уведомлений от сервера об изменениях состояния.
 *
 * Вызываемые методы сторов (создаются параллельно другим агентом, см. §F8 плана):
 *   useSessionStore: upsertPlayer, removePlayer, setPlayers, setSettings, reset, loadByCode
 *   useGameStore:    onGameStarted, setMyRole, applyPhase, applyNightResult,
 *                    setVoteCounts, applyVoteResult, markEliminated,
 *                    setActionSubmitted, addCheckResult, queueAnnouncement, setResult
 */

type WsMessage = { type: string; payload?: unknown };
type WsPayloadRecord = Record<string, unknown>;

const PING_MESSAGE = JSON.stringify({ type: 'ping' });
const PONG_MESSAGE = JSON.stringify({ type: 'pong' });
const NO_RECONNECT_CODES = new Set([4000, 4001, 4003]);
// Если backend не ответил pong в течение этого окна после нашего ping —
// считаем сокет мёртвым и форсируем close → onclose запустит reconnect.
const PONG_TIMEOUT_MS = 15_000;
// Капируем delay экспоненциального backoff'а, но НЕ количество попыток.
// Раньше после ~15 попыток (≈10 минут) клиент сдавался — это убивало UX в
// случае долгого отсутствия сети. Теперь пробуем бесконечно с потолком 30s.
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_BACKOFF_EXPONENT = 6; // 500 * 2^6 = 32_000 → клампится до 30_000

function isPayloadRecord(payload: unknown): payload is WsPayloadRecord {
  return typeof payload === 'object' && payload !== null;
}

function getPayloadString(payload: unknown, key: string): string | undefined {
  if (!isPayloadRecord(payload)) {
    return undefined;
  }

  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

/** Локальный обработчик персонального кика: логаут не нужен, просто редирект и reset. */
function handleKicked() {
  try {
    useSessionStore.getState().reset();
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined') {
    window.location.href = '/';
  }
}

// ---------------------------------------------------------------------------
// Handler map: каждый обработчик вызывает getState() только нужного стора.
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, (payload: unknown) => void> = {
  player_joined: (payload) => {
    if (isPayloadRecord(payload)) {
      useSessionStore.getState().upsertPlayer(payload as unknown as PlayerInList);
    }
  },

  player_left: (payload) => {
    const playerId = getPayloadString(payload, 'player_id');
    if (playerId) {
      useSessionStore.getState().removePlayer(playerId);
    }
  },

  player_kicked: (payload) => {
    const playerId = getPayloadString(payload, 'player_id');
    if (playerId) {
      useSessionStore.getState().removePlayer(playerId);
    }
  },

  player_renamed: (payload) => {
    const playerId = getPayloadString(payload, 'player_id');
    const name = getPayloadString(payload, 'name');
    if (playerId && name) {
      useSessionStore.getState().applyPlayerRenamed(playerId, name);
    }
  },

  story_phase_started: () => {
    // Хост запустил этап сюжета/выбора имён — все переходим на страницу сюжета.
    if (typeof window === 'undefined') return;
    const code = useSessionStore.getState().session?.code;
    if (!code) return;
    const target = `/sessions/${code}/stories`;
    if (window.location.pathname !== target) {
      // Client-side навигация без перезагрузки, чтобы Zustand-store с players/myPlayerId
      // не терялся (full reload ломает выбор имени и таймер).
      navigateTo(target);
    }
  },

  settings_updated: (payload) => {
    const settings = isPayloadRecord(payload) && 'settings' in payload
      ? payload.settings
      : payload;
    if (!isPayloadRecord(settings)) {
      return;
    }
    const sessionStore = useSessionStore.getState();
    if (typeof sessionStore.applySessionSettings === 'function') {
      sessionStore.applySessionSettings(settings as unknown as SessionSettings);
      return;
    }
    void sessionStore.setSettings(settings as Partial<SessionSettings>);
  },

  audio_preload_ready: (payload) => {
    if (isPayloadRecord(payload)) {
      useSessionStore.getState().setAudioPreloadStatus(payload as unknown as AudioPreloadStatusResponse);
    }
  },

  session_closed: () => {
    useSessionStore.getState().reset?.();
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  },

  kicked: () => handleKicked(),

  game_started: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().onGameStarted(payload);
    }
  },

  role_assigned: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().setMyRole(payload);
    }
  },

  phase_changed: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyPhase(payload);
    }
  },

  action_required: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyActionRequired(payload);
    }
  },

  action_blocked: () => {
    useGameStore.getState().applyActionBlocked();
  },

  action_timeout: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyActionTimeout(payload);
    }
  },

  role_acknowledged: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyRoleAcknowledged(payload);
    }
  },

  all_acknowledged: () => {
    useGameStore.getState().applyAllAcknowledged();
  },

  night_result: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyNightResult(payload);
    }
  },

  vote_update: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().setVoteCounts(payload);
    }
  },

  story_vote_update: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyStoryVoteUpdate(payload as {
        counts?: Record<string, number>;
        voted?: number;
        alive_total?: number;
      });
    }
  },

  story_vote_result: () => {
    // Победитель зафиксирован на бэке; переход в role_reveal придёт
    // отдельным событием game_started. Здесь ничего делать не нужно.
  },

  vote_result: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyVoteResult(payload);
    }
  },

  player_eliminated: (payload) => {
    const playerId = getPayloadString(payload, 'player_id');
    if (playerId) {
      useGameStore.getState().markEliminated(playerId);
    }
  },

  action_confirmed: () => {
    useGameStore.getState().setActionSubmitted(true);
  },

  check_result: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().addCheckResult(payload);
    }
  },

  announcement: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().queueAnnouncement(payload);
    }
  },

  game_finished: (payload) => {
    if (isPayloadRecord(payload)) {
      useGameStore.getState().setResult(payload);
    }
  },

  game_paused: () => {
    if (!useSessionStore.getState().timerPaused) {
      useSessionStore.setState({ timerPaused: true });
    }
  },

  game_resumed: (payload) => {
    useSessionStore.setState({ timerPaused: false });
    if (isPayloadRecord(payload)) {
      useGameStore.getState().applyPhase(payload);
    }
  },

  session_reset: (payload) => {
    // Новая семантика: первый нажавший «Вернуться в лобби» становится хостом и
    // сбрасывает сессию. Остальные игроки остаются на FinaleScreen и сами решают:
    // нажать «Вернуться в лобби» (фронт вызовет reset_to_lobby → 403 → join) или
    // «На главную». Принудительный redirect отсюда удалён намеренно.
    const newHostUserId = getPayloadString(payload, 'new_host_user_id');
    if (newHostUserId) {
      useSessionStore.getState().applyHostTransfer(newHostUserId);
    }
  },

  host_transferred: (payload) => {
    const newHostUserId = getPayloadString(payload, 'new_host_user_id');
    const newHostPlayerId = getPayloadString(payload, 'new_host_player_id') ?? null;
    if (newHostUserId) {
      useSessionStore.getState().applyHostTransfer(newHostUserId, newHostPlayerId);
    }
  },

  pong: () => {},
};

class WsClient {
  private socket: WebSocket | null = null;
  private heartbeatId: number | null = null;
  private pongTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private currentSessionId: string | null = null;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  connect(sessionId: string): void {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    // Переиспользуем уже открытый сокет, если сессия совпадает.
    if (
      this.socket &&
      this.currentSessionId === sessionId &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    // Если был подключён к другой сессии — чисто отключимся.
    if (this.socket) {
      this.disconnect();
    }

    const url = `${WS_BASE_URL}/ws/sessions/${sessionId}?token=${encodeURIComponent(token)}`;
    this.currentSessionId = sessionId;
    this.socket = new WebSocket(url);

    this.socket.onmessage = (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as unknown;
        if (!isPayloadRecord(parsed) || typeof parsed.type !== 'string') {
          logger.warn('ws.invalid_message', 'WebSocket received invalid message payload', {
            payload: parsed,
          }, { sessionId });
          return;
        }

        // Каждое WS-сообщение от сервера несёт server_now (UTC ISO) — см.
        // backend/services/ws_manager.py::_stamp_server_now. Обновляем
        // глобальный clock offset, чтобы все time-зависимые компоненты
        // (useCountdown, useNarrationAudio, NarratorScreen) могли
        // сравнивать серверные timestamps через serverNow(), а не Date.now()
        // — это убирает замерзание таймера/караоке при clock skew.
        const serverNow = typeof parsed.server_now === 'string' ? parsed.server_now : null;
        if (serverNow) {
          updateOffsetFromServerNow(serverNow);
        }

        this.dispatch({
          type: parsed.type,
          payload: parsed.payload,
        });
      } catch (err) {
        logger.warn('ws.parse_failed', 'Failed to parse WebSocket message', {
          reason: err instanceof Error ? err.message : String(err),
          raw: e.data,
        }, { sessionId });
      }
    };

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      logger.info('ws.connected', 'WebSocket connected', { sessionId }, { sessionId });
      // Ре-синк состояния: после (re)connect дергаем /state, чтобы догнать
      // сообщения, которые backend мог отправить, пока сокет ещё не был в OPEN.
      // /state доступен только в активной игре — пока сессия в лобби
      // (status=waiting) фаза ещё не создана и backend вернул бы 403. В лобби
      // gameStore сброшен (phase=null), поэтому ресинк там пропускаем и не
      // засоряем консоль 403-ошибкой.
      const sid = this.currentSessionId;
      if (sid && useGameStore.getState().phase !== null) {
        useGameStore
          .getState()
          .loadState(sid)
          .then(() => {
            logger.info('ws.resync_completed', 'Game state resync completed', { sessionId: sid }, { sessionId: sid });
          })
          .catch((err) => {
            logger.warn('ws.state_resync_failed', 'Game state resync failed', {
              reason: err instanceof Error ? err.message : String(err),
            }, { sessionId: sid });
          });
      }
    };

    this.socket.onclose = (e: CloseEvent) => this.handleClose(e);

    this.socket.onerror = (err: Event) => {
      logger.warn('ws.socket_error', 'WebSocket reported an error event', {
        type: err.type,
      }, { sessionId });
    };
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    if (this.socket) {
      try {
        this.socket.onclose = null;
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onopen = null;
        this.socket.close();
      } catch {
        // ignore
      }
    }
    this.socket = null;
    this.currentSessionId = null;
    this.reconnectAttempts = 0;
  }

  private dispatch(msg: WsMessage): void {
    // ping от сервера → отвечаем pong (любое сообщение тоже сбрасывает pong-watchdog).
    if (msg.type === 'ping') {
      this.clearPongWatchdog();
      this.sendRaw(PONG_MESSAGE);
      return;
    }
    if (msg.type === 'pong') {
      this.clearPongWatchdog();
      return;
    }
    // Любое валидное сообщение от сервера — признак жизни сокета.
    this.clearPongWatchdog();

    const handler = HANDLERS[msg.type];
    if (handler) {
      handler(msg.payload);
    } else {
      logger.warn('ws.invalid_message', 'WebSocket received unknown message type', {
        type: msg.type,
        payload: msg.payload,
      }, { sessionId: this.currentSessionId });
    }
  }

  private sendRaw(data: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(data);
      } catch (err) {
        logger.warn('ws.send_failed', 'WebSocket send failed', {
          reason: err instanceof Error ? err.message : String(err),
        }, { sessionId: this.currentSessionId });
      }
    }
  }

  private clearPongWatchdog(): void {
    if (this.pongTimeoutId !== null) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  private armPongWatchdog(): void {
    this.clearPongWatchdog();
    this.pongTimeoutId = setTimeout(() => {
      this.pongTimeoutId = null;
      logger.warn('ws.pong_timeout', 'WebSocket pong timeout, forcing reconnect', {
        timeoutMs: PONG_TIMEOUT_MS,
      }, { sessionId: this.currentSessionId });
      // Закрываем сокет — onclose-обработчик запустит reconnect через бэкофф.
      try {
        this.socket?.close();
      } catch {
        // ignore
      }
    }, PONG_TIMEOUT_MS);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatId = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(PING_MESSAGE);
          // Запускаем watchdog: если pong не придёт за PONG_TIMEOUT_MS — реконнектим.
          this.armPongWatchdog();
        } catch (err) {
          logger.warn('ws.heartbeat_failed', 'WebSocket heartbeat send failed', {
            reason: err instanceof Error ? err.message : String(err),
          }, { sessionId: this.currentSessionId });
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatId !== null) {
      window.clearInterval(this.heartbeatId);
      this.heartbeatId = null;
    }
    this.clearPongWatchdog();
  }

  private handleClose(e: CloseEvent): void {
    this.stopHeartbeat();
    // 4000 (kick), 4001 (bad token), 4003 (not in session) — не переподключаемся.
    if (NO_RECONNECT_CODES.has(e.code)) {
      this.socket = null;
      this.currentSessionId = null;
      return;
    }

    const sessionId = this.currentSessionId;
    if (!sessionId) return;

    // Экспоненциальный backoff: 500ms * 2^n, потолок MAX_RECONNECT_DELAY_MS.
    // Без лимита попыток: пользователь может уехать в лифт на час, при возврате
    // сети window.online событие сбросит attempts и подключится без ожидания.
    const exponent = Math.min(this.reconnectAttempts, MAX_BACKOFF_EXPONENT);
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * Math.pow(2, exponent));
    this.reconnectAttempts += 1;
    logger.warn('ws.reconnect_scheduled', 'Scheduling WebSocket reconnect', {
      code: e.code,
      reason: e.reason,
      delay,
      attempt: this.reconnectAttempts,
    }, { sessionId });

    // Сбрасываем ссылку на мёртвый сокет, чтобы connect() мог создать новый.
    this.socket = null;

    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null;
      // Проверяем, не был ли disconnect() вызван за это время.
      if (this.currentSessionId === sessionId) {
        this.connect(sessionId);
      }
    }, delay);
  }

  /**
   * Вызывается из глобального online-listener. Сбрасывает backoff и сразу
   * пытается переподключиться к текущей сессии — иначе придётся ждать до
   * 30s до следующей попытки бэкоффа.
   */
  handleOnline(): void {
    if (!this.currentSessionId || this.socket) {
      return;
    }
    logger.info('ws.network_restored', 'Network restored, reconnecting immediately', {
      sessionId: this.currentSessionId,
    }, { sessionId: this.currentSessionId });
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    this.reconnectAttempts = 0;
    this.connect(this.currentSessionId);
  }
}

export const wsClient = new WsClient();

// Глобальные слушатели: при возврате сети сразу дёргаем reconnect, не ждём
// бэкофф-таймер. visibilitychange ловит «вернулся на вкладку» — браузеры
// замораживают WS на фоне, после fg она может оказаться dead.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => wsClient.handleOnline());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      wsClient.handleOnline();
    }
  });
}
