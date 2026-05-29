import { create } from 'zustand';
import { Session, SessionSettings, LobbyPlayer, RoleConfig } from '../types/game';
import type {
  CreateSessionRequest,
  PlayerInList,
  SessionDetailResponse,
  UpdateSettingsRequest,
  AudioPreloadStatusResponse,
} from '../types/api';
import { sessionApi } from '../api/sessionApi';
import { useAuthStore } from './authStore';
import { createDefaultSessionSettings } from '../utils/sessionDefaults';
import { logger } from '../services/logger';

export const MAX_PLAYERS = 12;
export const MIN_PLAYERS = 5;

export function getSpecialRolesCount(rc: RoleConfig): number {
  return rc.mafia + rc.don + rc.sheriff + rc.doctor + rc.lover + rc.maniac;
}

export function getCiviliansCount(playerCount: number, rc: RoleConfig): number {
  return Math.max(0, playerCount - getSpecialRolesCount(rc));
}

export const DEFAULT_SETTINGS = createDefaultSessionSettings();

interface SessionState {
  session: Session | null;
  players: LobbyPlayer[];
  settings: SessionSettings;
  isHost: boolean;
  myPlayerId: string | null;

  // Client-only fields for story voting (not persisted to backend)
  withStory: boolean;
  selectedStoryId: string | null;
  timerPaused: boolean;
  audioPreloadStatus: AudioPreloadStatusResponse | null;

  // API-backed actions
  createSession: (data: CreateSessionRequest) => Promise<string>;
  joinSession: (code: string, name?: string) => Promise<void>;
  loadByCode: (code: string) => Promise<void>;
  setSettings: (settings: UpdateSettingsRequest) => Promise<void>;
  hydrateSessionDetail: (detail: SessionDetailResponse) => void;

  // WebSocket hooks
  upsertPlayer: (player: PlayerInList) => void;
  removePlayer: (playerId: string) => void;
  setPlayers: (list: PlayerInList[]) => void;
  applySessionSettings: (settings: SessionSettings) => void;
  applyHostTransfer: (newHostUserId: string, newHostPlayerId?: string | null) => void;
  applyPlayerRenamed: (playerId: string, name: string) => void;
  setAudioPreloadStatus: (status: AudioPreloadStatusResponse | null) => void;

  // API: переименование своего игрока (этап выбора имени после сюжета).
  setMyName: (name: string) => Promise<void>;

  // Local-only actions
  setWithStory: (value: boolean) => void;
  setSelectedStory: (storyId: string) => void;
  setTimerPaused: (paused: boolean) => Promise<void>;
  reset: () => void;
}

// Cached lazy import to break circular dependency with gameStore.
let _gameStoreModule: typeof import('./gameStore') | null = null;
async function getGameStore() {
  if (!_gameStoreModule) {
    _gameStoreModule = await import('./gameStore');
  }
  return _gameStoreModule;
}

function playersFromList(list: PlayerInList[]): LobbyPlayer[] {
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    username: p.username ?? null,
    join_order: p.join_order,
    is_host: p.is_host,
  }));
}

function stateFromSessionDetail(detailData: SessionDetailResponse) {
  const currentUser = useAuthStore.getState().user;
  const players = playersFromList(detailData.players);
  const myPlayer = detailData.players.find((p) => p.is_me);
  return {
    session: detailData,
    players,
    settings: detailData.settings,
    isHost: currentUser ? detailData.host_user_id === currentUser.user_id : false,
    myPlayerId: myPlayer?.id ?? null,
    audioPreloadStatus: null,
  };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  session: null,
  players: [],
  settings: createDefaultSessionSettings(),
  isHost: false,
  myPlayerId: null,

  withStory: false,
  selectedStoryId: null,
  timerPaused: false,
  audioPreloadStatus: null,

  createSession: async (data) => {
    const response = await sessionApi.create(data);
    const session = response.data;
    // Hydrate full detail + players via getByCode (players содержат is_me для определения своего слота).
    const detail = await sessionApi.getByCode(session.code);
    const detailData = detail.data;
    const nextState = stateFromSessionDetail(detailData);
    set({ ...nextState, isHost: true });
    logger.info('session.create_success', 'Session created successfully', {
      sessionId: detailData.id,
      playerCount: detailData.player_count,
    }, { sessionId: detailData.id });
    return session.code;
  },

  joinSession: async (code, name) => {
    const joinResponse = await sessionApi.join(code, name ? { name } : {});
    const joinData = joinResponse.data;
    const detail = await sessionApi.getByCode(code);
    const detailData = detail.data;
    const nextState = stateFromSessionDetail(detailData);
    set({ ...nextState, myPlayerId: nextState.myPlayerId ?? joinData.player_id });
    logger.info('session.join_success', 'Joined session successfully', {
      sessionId: detailData.id,
      playerId: nextState.myPlayerId ?? joinData.player_id,
    }, { sessionId: detailData.id });
  },

  loadByCode: async (code) => {
    const detail = await sessionApi.getByCode(code);
    const detailData = detail.data;
    set(stateFromSessionDetail(detailData));
    logger.info('session.load_success', 'Session state loaded', {
      sessionId: detailData.id,
    }, { sessionId: detailData.id });
  },

  hydrateSessionDetail: (detail) => {
    set(stateFromSessionDetail(detail));
  },

  setSettings: async (newSettings) => {
    const state = get();
    if (!state.session) return;
    // Sanitize: only forward fields supported by backend.
    const payload: UpdateSettingsRequest = {};
    if (newSettings.role_reveal_timer_seconds !== undefined) {
      payload.role_reveal_timer_seconds = newSettings.role_reveal_timer_seconds;
    }
    if (newSettings.discussion_timer_seconds !== undefined) {
      payload.discussion_timer_seconds = newSettings.discussion_timer_seconds;
    }
    if (newSettings.voting_timer_seconds !== undefined) {
      payload.voting_timer_seconds = newSettings.voting_timer_seconds;
    }
    if (newSettings.night_action_timer_seconds !== undefined) {
      payload.night_action_timer_seconds = newSettings.night_action_timer_seconds;
    }
    if (newSettings.role_config) {
      const rc = newSettings.role_config;
      const filtered: Partial<RoleConfig> = {};
      if (rc.mafia !== undefined) filtered.mafia = rc.mafia;
      if (rc.don !== undefined) filtered.don = rc.don;
      if (rc.sheriff !== undefined) filtered.sheriff = rc.sheriff;
      if (rc.doctor !== undefined) filtered.doctor = rc.doctor;
      if (rc.lover !== undefined) filtered.lover = rc.lover;
      if (rc.maniac !== undefined) filtered.maniac = rc.maniac;
      payload.role_config = filtered;
    }
    if (newSettings.use_story_engine !== undefined) {
      payload.use_story_engine = newSettings.use_story_engine;
    }
    if (newSettings.story_id !== undefined) {
      payload.story_id = newSettings.story_id;
    }
    if (newSettings.timer_multiplier !== undefined) {
      payload.timer_multiplier = newSettings.timer_multiplier;
    }
    if (newSettings.inter_cue_pause_seconds !== undefined) {
      payload.inter_cue_pause_seconds = newSettings.inter_cue_pause_seconds;
    }
    const response = await sessionApi.updateSettings(state.session.id, payload);
    const updated = response.data?.settings as SessionSettings | undefined;
    if (updated) {
      set({ settings: updated });
    } else {
      // Optimistic fallback: merge locally.
      set((s) => ({
        settings: {
          ...s.settings,
          ...newSettings,
          role_config: {
            ...s.settings.role_config,
            ...(newSettings.role_config || {}),
          },
        },
      }));
    }
    logger.info('session.settings_updated', 'Session settings updated on frontend', {
      sessionId: state.session.id,
      updatedFields: Object.keys(payload),
    }, { sessionId: state.session.id });
  },

  upsertPlayer: (player) => {
    set((state) => {
      const idx = state.players.findIndex((p) => p.id === player.id);
      const mapped: LobbyPlayer = {
        id: player.id,
        name: player.name,
        username: player.username ?? null,
        join_order: player.join_order,
        is_host: player.is_host,
      };
      if (idx >= 0) {
        const next = [...state.players];
        next[idx] = mapped;
        return { players: next };
      }
      if (state.players.length >= MAX_PLAYERS) return state;
      return { players: [...state.players, mapped] };
    });
  },

  removePlayer: (playerId) => {
    set((state) => ({
      players: state.players.filter((p) => p.id !== playerId),
    }));
  },

  setPlayers: (list) => {
    set({ players: playersFromList(list) });
  },

  applySessionSettings: (settings) => {
    set({ settings });
  },

  applyPlayerRenamed: (playerId, name) => {
    set((state) => ({
      players: state.players.map((p) =>
        p.id === playerId ? { ...p, name } : p,
      ),
    }));
  },

  setAudioPreloadStatus: (status) => {
    set({ audioPreloadStatus: status });
  },

  setMyName: async (name) => {
    const state = get();
    if (!state.session) return;
    const response = await sessionApi.setMyName(state.session.id, name);
    const data = response.data;
    set((s) => ({
      players: s.players.map((p) =>
        p.id === data.player_id ? { ...p, name: data.name } : p,
      ),
    }));
    logger.info('session.player_renamed', 'Player renamed', {
      sessionId: state.session.id,
      playerId: data.player_id,
      name: data.name,
    }, { sessionId: state.session.id });
  },

  applyHostTransfer: (newHostUserId, newHostPlayerId) => {
    const currentUser = useAuthStore.getState().user;
    set((state) => {
      const nextSession = state.session
        ? { ...state.session, host_user_id: newHostUserId }
        : state.session;
      // Пометить нового хоста, снять пометку со старого.
      const nextPlayers = state.players.map((p) => {
        const isNew = newHostPlayerId ? p.id === newHostPlayerId : false;
        return { ...p, is_host: isNew };
      });
      return {
        session: nextSession,
        players: nextPlayers,
        isHost: currentUser ? currentUser.user_id === newHostUserId : false,
      };
    });
  },

  setWithStory: (value) => {
    set({ withStory: value });
  },

  setSelectedStory: (storyId) => {
    set({ selectedStoryId: storyId });
  },

  setTimerPaused: async (paused) => {
    const state = get();
    // sessionStore.session may be null after game page refresh;
    // fall back to gameStore.sessionId which is always set by loadState.
    const { useGameStore: gStore } = await getGameStore();
    const sessionId = state.session?.id ?? gStore.getState().sessionId;
    if (!sessionId) return;

    // Diagnostic: логируем call-stack чтобы поймать неожиданный источник
    // (auto-test, browser ext, accidental keyboard event и т.п.). Будем
    // удалять после того как разберёмся с pause-spam'ом в проде.
    const stack = new Error().stack ?? '<no stack>';
    logger.info('debug.setTimerPaused_called', 'setTimerPaused invoked', {
      sessionId,
      paused,
      currentPaused: state.timerPaused,
      stack: stack.split('\n').slice(1, 6).join(' | '),
    }, { sessionId });

    // Optimistic update: мгновенно меняем UI чтобы пользователь не ждал
    // round-trip POST + WS broadcast (60-200ms на проде). Без этого хост
    // жмёт кнопку и видит "ничего не происходит" пока WS `game_paused`
    // не дойдёт. WS-обработчики (game_paused/game_resumed) перезатрут наше
    // значение тем же — race-safe. На случай ошибки API ниже откатываем.
    const previousPaused = state.timerPaused;
    set({ timerPaused: paused });

    try {
      if (paused) {
        await sessionApi.pause(sessionId);
      } else {
        await sessionApi.resume(sessionId);
      }
      logger.info(paused ? 'game.pause_submit' : 'game.resume_submit', paused ? 'Pause requested' : 'Resume requested', {
        sessionId,
      }, { sessionId });
    } catch {
      // Откат optimistic update — реальное состояние не изменилось.
      // Если бек вернул 409 (already_paused / not_paused) — значит мы
      // уже синхронизированы, WS-сообщение от первой попытки придёт само.
      set({ timerPaused: previousPaused });
      logger.warn('api.nonfatal_failure', 'Pause/resume request failed, reverting optimistic update', {
        sessionId,
        paused,
      }, { sessionId });
    }
  },

  reset: () => {
    set({
      session: null,
      players: [],
      settings: createDefaultSessionSettings(),
      isHost: false,
      myPlayerId: null,
      withStory: false,
      selectedStoryId: null,
      timerPaused: false,
      audioPreloadStatus: null,
    });
  },
}));
