import { create } from 'zustand';
import { Role, Player, Target, Announcement, VoteInfo, GameResult, Phase, SessionSettings, StoryVoteInfo, StoryVoteCard, NamePickInfo, NamePickOption } from '../types/game';
import type { AcknowledgeRoleResponse, GameStateResponse, NightActionCheckResult } from '../types/api';
import { gameApi } from '../api/gameApi';
import { useSessionStore } from './sessionStore';
import { logger } from '../services/logger';

export type GameScreen =
  | 'syncing'
  | 'role_reveal'
  | 'narrator'
  | 'name_pick'
  | 'night_action'
  | 'night_waiting'
  | 'day_discussion'
  | 'day_voting'
  | 'eliminated'
  | 'story_vote'
  | 'finale';

export type NightActionType =
  | 'kill'
  | 'check'
  | 'heal'
  | 'don_check'
  | 'lover_visit'
  | 'maniac_kill';

export interface CheckResultEntry {
  targetId: string;
  team?: 'mafia' | 'city' | 'maniac';
  isSheriff?: boolean;
  actionType: NightActionType;
}

export interface NightKill {
  player_id: string;
  name: string;
  killer?: string;
}

type HealRestriction = { player_id: string; name: string; reason: string } | null;
type PhaseLike = Partial<Phase> & {
  id?: string | null;
  timer_started_at?: string | null;
  started_at?: string | null;
};
type SessionStatus = 'active' | 'finished' | 'waiting';
type StateResponsePayload = GameStateResponse & {
  settings?: Partial<SessionSettings>;
  my_vote_submitted?: boolean;
};
type GameStartedPayload = {
  phase?: PhaseLike | null;
  timer_seconds?: number | null;
  started_at?: string | null;
};
type PhasePayload = {
  phase?: PhaseLike | null;
  sub_phase?: Phase['sub_phase'];
  timer_seconds?: number | null;
  timer_started_at?: string | null;
  session_status?: SessionStatus;
  awaiting_action?: boolean;
  action_type?: NightActionType | null;
  available_targets?: Target[] | null;
  announcement?: Announcement | null;
  stories?: StoryVoteCard[];
  names?: NamePickOption[];
};
type StoryVoteUpdatePayload = {
  counts?: Record<string, number>;
  voted?: number;
  alive_total?: number;
};
type ActionRequiredPayload = {
  action_type?: NightActionType | null;
  available_targets?: Target[] | null;
  heal_restriction?: HealRestriction;
  timer_started_at?: string | null;
};
type ActionTimeoutPayload = {
  action_type?: string;
};
type RoleAcknowledgedPayload = {
  players_acknowledged?: number;
  players_total?: number;
};
type NightResultPayload = {
  died?: Array<{ player_id: string; name: string }>;
  day_blocked_player?: string | null;
  announcement?: Announcement | null;
};
type VoteCountsPayload = {
  votes_cast?: number;
  cast?: number;
  votes_total?: number;
  total_expected?: number;
  counts?: Record<string, number>;
};
type VoteResultPayload = {
  eliminated?: { player_id?: string | null } | null;
  eliminated_player_id?: string | null;
  announcement?: Announcement | null;
};
type CheckResultPayload = {
  target_player_id?: string;
  targetId?: string;
  action_type?: NightActionType | null;
  check_result?: NightActionCheckResult;
  team?: NightActionCheckResult['team'];
  is_sheriff?: boolean;
  match?: boolean;
};
type ResultPayload = {
  winner?: GameResult['winner'];
  announcement?: Announcement | null;
  final_roster?: GameResult['players'];
  players?: GameResult['players'];
};

interface GameState {
  screen: GameScreen;
  sessionId: string | null;
  sessionCode: string | null;
  phase: Phase | null;
  nightNumber: number;
  dayNumber: number;

  // My player
  myPlayerId: string | null;
  myPlayerName: string | null;
  myRole: Role | null;
  myStatus: 'alive' | 'dead';
  myIsBlockedTonight: boolean;

  // Players
  players: Player[];

  // Role reveal
  acknowledged: boolean;
  acknowledgedCount: number;
  totalPlayers: number;

  // Narrator / announcements
  currentAnnouncement: Announcement | null;

  // Night action
  awaitingAction: boolean;
  actionType: NightActionType | null;
  actionLabel: string;
  availableTargets: Target[];
  selectedTarget: string | null;
  actionSubmitted: boolean;
  checkResults: CheckResultEntry[];
  healRestriction: HealRestriction;

  // Night result tracking
  nightKills: NightKill[];
  nightResultDied: { player_id: string; name: string }[] | null;
  nightResultText: string;

  // Day
  votes: VoteInfo | null;
  voteSubmitted: boolean;
  voteTarget: string | null;
  voteCounts: Record<string, number>;
  dayBlockedPlayer: string | null;

  // Story vote (фича 3)
  storyVote: StoryVoteInfo | null;
  storyVoteSubmitted: boolean;
  storyVoteTarget: string | null;

  // Name pick (имена пер-сюжет): выбор имени после story_vote
  namePick: NamePickInfo | null;
  namePickSubmitted: boolean;

  // Finale
  result: GameResult | null;

  // Actions — loaders / submitters
  loadState: (sessionId: string) => Promise<void>;
  submitNightAction: (targetId: string) => Promise<void>;
  submitVote: (targetId: string | null) => Promise<void>;
  submitStoryVote: (storyId: string) => Promise<void>;
  applyStoryVoteUpdate: (payload: StoryVoteUpdatePayload) => void;
  submitNamePick: (name: string) => Promise<void>;
  acknowledgeRole: () => Promise<void>;

  // Plain setters (still used by screen-local logic)
  setScreen: (screen: GameScreen) => void;
  setSessionId: (id: string) => void;
  setMyPlayerId: (id: string) => void;
  setPlayers: (players: Player[]) => void;
  updatePlayerStatus: (playerId: string, status: 'alive' | 'dead') => void;
  setSelectedTarget: (targetId: string | null) => void;
  advanceNarrator: () => void;

  // WebSocket hooks
  onGameStarted: (payload: GameStartedPayload) => void;
  setMyRole: (payload: { role?: Role | null } | Role | null) => void;
  applyPhase: (payload: PhasePayload | PhaseLike) => void;
  applyActionRequired: (payload: ActionRequiredPayload) => void;
  applyActionBlocked: () => void;
  applyActionTimeout: (payload: ActionTimeoutPayload) => void;
  applyRoleAcknowledged: (payload: RoleAcknowledgedPayload) => void;
  applyAllAcknowledged: () => void;
  applyNightResult: (payload: NightResultPayload) => void;
  setVoteCounts: (payload: VoteCountsPayload) => void;
  applyVoteResult: (payload: VoteResultPayload) => void;
  markEliminated: (playerId: string) => void;
  setActionSubmitted: (value: boolean) => void;
  addCheckResult: (payload: CheckResultPayload) => void;
  queueAnnouncement: (payload: { announcement?: Announcement } | Announcement) => void;
  setResult: (payload: ResultPayload) => void;

  reset: () => void;
}

/**
 * Map backend phase.type/sub_phase + awaiting_action to frontend GameScreen.
 */
function deriveScreen(
  phaseType: Phase['type'] | 'finished' | null | undefined,
  subPhase: Phase['sub_phase'] | undefined,
  awaitingAction: boolean,
  sessionStatus?: SessionStatus,
): GameScreen {
  if (sessionStatus === 'finished' || phaseType === 'finished') {
    return 'finale';
  }
  if (sessionStatus === 'active' && !phaseType) return 'syncing';
  if (phaseType === 'role_reveal') return 'role_reveal';
  if (phaseType === 'night') {
    return awaitingAction ? 'night_action' : 'night_waiting';
  }
  if (phaseType === 'day') {
    if (subPhase === 'voting') return 'day_voting';
    return 'day_discussion';
  }
  if (phaseType === 'story_vote') return 'story_vote';
  if (phaseType === 'name_pick') return 'name_pick';
  return 'role_reveal';
}

function actionLabelFor(type: NightActionType | null): string {
  switch (type) {
    case 'kill': return 'Выберите цель';
    case 'check': return 'Кого проверить?';
    case 'don_check': return 'Кого проверить на роль шерифа?';
    case 'heal': return 'Кого вылечить?';
    case 'lover_visit': return 'Кого посетить?';
    case 'maniac_kill': return 'Выберите жертву';
    default: return '';
  }
}

function announcementIdentity(announcement: Announcement | null | undefined): string {
  if (!announcement?.text) return '';
  return `${announcement.key ?? ''}|${announcement.step_index ?? ''}|${announcement.text}`;
}

function sameAnnouncement(
  left: Announcement | null | undefined,
  right: Announcement | null | undefined,
): boolean {
  const leftId = announcementIdentity(left);
  return leftId !== '' && leftId === announcementIdentity(right);
}

function actionWindowIdentity(
  phase: PhaseLike | null | undefined,
  actionType: NightActionType | null | undefined,
): string {
  if (!phase?.type) return '';
  return [
    phase.id ?? '',
    phase.type,
    phase.number ?? '',
    phase.timer_started_at ?? '',
    actionType ?? '',
  ].join('|');
}

function resolveAnnouncement(
  current: Announcement | null,
  incoming: Announcement | null | undefined,
): Announcement | null {
  return sameAnnouncement(current, incoming) ? current : incoming ?? null;
}

function hasBlockingAnnouncement(announcement: Announcement | null | undefined): boolean {
  return Boolean(announcement?.text) && announcement?.blocking !== false;
}

function applyAnnouncementScreen(
  fallbackScreen: GameScreen,
  announcement: Announcement | null,
): GameScreen {
  return hasBlockingAnnouncement(announcement) ? 'narrator' : fallbackScreen;
}

function mergeSessionSettings(incoming: Partial<SessionSettings> | undefined): void {
  if (!incoming) {
    return;
  }

  useSessionStore.setState((prev) => ({
    settings: {
      ...prev.settings,
      ...incoming,
      role_config: {
        ...prev.settings.role_config,
        ...(incoming.role_config ?? {}),
      },
    },
  }));
}

function syncPauseState(gamePaused: boolean | undefined): void {
  if (gamePaused == null) {
    return;
  }

  useSessionStore.setState({ timerPaused: gamePaused });
}

function buildPhase(
  rawPhase: PhaseLike | null | undefined,
  overrides?: {
    sub_phase?: Phase['sub_phase'];
    timer_seconds?: number | null;
    timer_started_at?: string | null;
  },
): Phase | null {
  if (!rawPhase?.type) {
    return null;
  }

  return {
    id: rawPhase.id ?? '',
    type: rawPhase.type,
    number: rawPhase.number ?? 0,
    sub_phase: overrides?.sub_phase ?? rawPhase.sub_phase ?? null,
    started_at: rawPhase.started_at ?? '',
    timer_seconds: overrides?.timer_seconds ?? rawPhase.timer_seconds ?? null,
    timer_started_at: overrides?.timer_started_at ?? rawPhase.timer_started_at ?? null,
    vote_round: rawPhase.vote_round,
  };
}

function buildCheckResultEntry(
  targetId: string,
  actionType: NightActionType,
  result: NightActionCheckResult,
): CheckResultEntry {
  return {
    targetId,
    actionType,
    team: result.team,
    isSheriff: result.is_sheriff ?? result.match,
  };
}

function isAnnouncementEnvelope(
  payload: { announcement?: Announcement } | Announcement,
): payload is { announcement?: Announcement } {
  return 'announcement' in payload;
}

const initialState = {
  screen: 'role_reveal' as GameScreen,
  sessionId: null,
  sessionCode: null,
  phase: null,
  nightNumber: 0,
  dayNumber: 0,
  myPlayerId: null,
  myPlayerName: null,
  myRole: null,
  myStatus: 'alive' as const,
  myIsBlockedTonight: false,
  players: [],
  acknowledged: false,
  acknowledgedCount: 0,
  totalPlayers: 0,
  currentAnnouncement: null,
  awaitingAction: false,
  actionType: null,
  actionLabel: '',
  availableTargets: [],
  selectedTarget: null,
  actionSubmitted: false,
  checkResults: [],
  healRestriction: null,
  nightKills: [],
  nightResultDied: null,
  nightResultText: '',
  votes: null,
  voteSubmitted: false,
  voteTarget: null,
  voteCounts: {},
  dayBlockedPlayer: null,
  storyVote: null,
  storyVoteSubmitted: false,
  storyVoteTarget: null,
  namePick: null,
  namePickSubmitted: false,
  result: null,
};

export const useGameStore = create<GameState>((set, get) => ({
  ...initialState,

  loadState: async (sessionId) => {
    const response = await gameApi.getState(sessionId);
    const data: StateResponsePayload = response.data;

    const phase = data.phase;
    const screen = deriveScreen(
      phase?.type,
      phase?.sub_phase,
      data.awaiting_action,
      data.session_status,
    );

    const myPlayer = data.my_player;
    const actionType = data.action_type ?? null;

    // Sync pause state and settings from backend into sessionStore.
    syncPauseState(data.game_paused);
    mergeSessionSettings(data.settings);
    const announcement = data.announcement ?? null;

    set((state) => {
      const nextAnnouncement = resolveAnnouncement(state.currentAnnouncement, announcement);
      const sameActionWindow =
        actionWindowIdentity(state.phase, state.actionType) === actionWindowIdentity(phase, actionType);

      return {
        sessionId,
        sessionCode: data.session_code ?? state.sessionCode,
        phase,
        screen: applyAnnouncementScreen(screen, nextAnnouncement),
        myPlayerId: myPlayer?.id ?? null,
        myPlayerName: myPlayer?.name ?? state.myPlayerName,
        myRole: myPlayer?.role ?? null,
        myStatus: myPlayer?.status ?? 'alive',
        myIsBlockedTonight: myPlayer?.is_blocked_tonight ?? false,
        players: data.players ?? [],
        totalPlayers: (data.players ?? []).length,
        acknowledged: data.role_reveal?.my_acknowledged ?? false,
        acknowledgedCount: data.role_reveal?.players_acknowledged ?? 0,
        awaitingAction: data.awaiting_action,
        actionType,
        actionLabel: actionLabelFor(actionType),
        availableTargets: data.available_targets ?? [],
        selectedTarget: sameActionWindow ? state.selectedTarget : null,
        actionSubmitted: data.my_action_submitted || (sameActionWindow ? state.actionSubmitted : false),
        voteSubmitted: data.my_vote_submitted || state.voteSubmitted,
        votes: data.votes ?? null,
        dayBlockedPlayer: data.day_blocked_player ?? null,
        storyVote: data.story_vote ?? (phase?.type === 'story_vote' ? state.storyVote : null),
        storyVoteSubmitted: data.story_vote?.my_vote != null || (phase?.type === 'story_vote' ? state.storyVoteSubmitted : false),
        storyVoteTarget: data.story_vote?.my_vote ?? (phase?.type === 'story_vote' ? state.storyVoteTarget : null),
        namePick: data.name_pick ?? (phase?.type === 'name_pick' ? state.namePick : null),
        namePickSubmitted:
          phase?.type === 'name_pick'
            ? (data.name_pick != null
                ? data.name_pick.my_name != null
                  && (data.name_pick.names ?? []).some((n) => n.display === data.name_pick!.my_name)
                : state.namePickSubmitted)
            : false,
        // Не затираем финальный result при re-sync: /state не возвращает
        // result, но в памяти он уже мог быть установлен через WS game_finished.
        result: data.result ?? state.result ?? null,
        nightNumber: phase?.type === 'night' ? phase.number : state.nightNumber,
        dayNumber: phase?.type === 'day' ? phase.number : state.dayNumber,
        currentAnnouncement: nextAnnouncement,
      };
    });
    logger.info('game.state_load', 'Game state loaded', {
      sessionId,
      phaseType: phase?.type ?? null,
      phaseNumber: phase?.number ?? null,
    }, { sessionId });
  },

  submitNightAction: async (targetId) => {
    const state = get();
    if (!state.sessionId) return;
    const response = await gameApi.nightAction(state.sessionId, targetId);
    const data = response.data;
    // Mark submitted locally; real result may arrive via WS too.
    set({ actionSubmitted: true, selectedTarget: targetId });
    // If backend returns check_result inline (for sheriff/don), store it.
    if (data?.check_result && state.actionType) {
      const entry = buildCheckResultEntry(targetId, state.actionType, data.check_result);
      set((s) => ({ checkResults: [...s.checkResults, entry] }));
    }
    logger.info('game.night_action_submit', 'Night action submitted', {
      sessionId: state.sessionId,
      actionType: state.actionType,
      targetId,
    }, { sessionId: state.sessionId });
  },

  submitVote: async (targetId) => {
    const state = get();
    if (!state.sessionId) return;
    await gameApi.vote(state.sessionId, targetId);
    set({ voteSubmitted: true, voteTarget: targetId });
    logger.info('game.vote_submit', 'Vote submitted', {
      sessionId: state.sessionId,
      targetId,
    }, { sessionId: state.sessionId });
  },

  submitStoryVote: async (storyId) => {
    const state = get();
    if (!state.sessionId) return;
    await gameApi.storyVote(state.sessionId, storyId);
    set({ storyVoteSubmitted: true, storyVoteTarget: storyId });
    logger.info('game.story_vote_submit', 'Story vote submitted', {
      sessionId: state.sessionId,
      storyId,
    }, { sessionId: state.sessionId });
  },

  applyStoryVoteUpdate: (payload) => {
    set((state) => {
      if (!state.storyVote) return state;
      return {
        storyVote: {
          ...state.storyVote,
          counts: payload.counts ?? state.storyVote.counts,
          voted: payload.voted ?? state.storyVote.voted,
          alive_total: payload.alive_total ?? state.storyVote.alive_total,
        },
      };
    });
  },

  submitNamePick: async (name) => {
    const state = get();
    if (!state.sessionId) return;
    await gameApi.namePick(state.sessionId, name);
    set((s) => ({
      namePickSubmitted: true,
      namePick: s.namePick ? { ...s.namePick, my_name: name } : s.namePick,
    }));
    logger.info('game.name_pick_submit', 'Name pick submitted', {
      sessionId: state.sessionId,
      name,
    }, { sessionId: state.sessionId });
  },

  acknowledgeRole: async () => {
    const state = get();
    if (!state.sessionId) return;
    try {
      const res = await gameApi.acknowledgeRole(state.sessionId);
      const body: Partial<AcknowledgeRoleResponse> = res?.data ?? res;
      const acked = body.players_acknowledged;
      const total = body.players_total;
      set({
        acknowledged: true,
        ...(acked != null ? { acknowledgedCount: Number(acked) } : {}),
        ...(total != null ? { totalPlayers: Number(total) } : {}),
      });
      logger.info('game.role_acknowledged', 'Role acknowledged by local player', {
        sessionId: state.sessionId,
        acknowledgedCount: acked ?? null,
        totalPlayers: total ?? null,
      }, { sessionId: state.sessionId });
    } catch {
      // Swallow — the local ack flag still flips so the user is not stuck.
      set({ acknowledged: true });
      logger.warn('api.nonfatal_failure', 'Role acknowledgement request failed, local state updated optimistically', {
        sessionId: state.sessionId,
      }, { sessionId: state.sessionId });
    }
  },

  setScreen: (screen) => set({ screen }),
  setSessionId: (sessionId) => set({ sessionId }),
  setMyPlayerId: (myPlayerId) => set({ myPlayerId }),
  setPlayers: (players) => set({ players, totalPlayers: players.length }),
  updatePlayerStatus: (playerId, status) => set((s) => {
    const idx = s.players.findIndex((p) => p.id === playerId);
    if (idx === -1 || s.players[idx].status === status) return s;
    const next = [...s.players];
    next[idx] = { ...next[idx], status };
    return {
      players: next,
      myStatus: s.myPlayerId === playerId ? status : s.myStatus,
    };
  }),
  setSelectedTarget: (selectedTarget) => set({ selectedTarget }),
  advanceNarrator: () => undefined,

  // --- WebSocket hooks -------------------------------------------------------

  onGameStarted: (payload) => {
    // Build phase from the game_started payload so timer_seconds is correct.
    const phase = buildPhase(payload.phase, {
      timer_seconds: payload.timer_seconds,
      timer_started_at: payload.started_at,
    });
    // Go straight to role_reveal — players read their cards first.
    // Rules narrator plays AFTER all acknowledge (via transition_to_night).
    set((state) => {
      // game_started переводит в role_reveal. Игнорируем его только если игра
      // уже ушла ДАЛЬШЕ выдачи ролей (ночь/день) или мы в финале — там это
      // устаревшее/повторное событие, которое затёрло бы текущую фазу. А вот
      // из пред-игровых фаз (story_vote / name_pick) переход в role_reveal
      // обязан происходить вживую — раньше этот guard его глушил, и роль-ревил
      // появлялся только после ручного обновления страницы.
      const cur = state.phase?.type;
      if (state.screen === 'finale' || state.result) return state;
      if (cur === 'night' || cur === 'day') return state;

      return {
        phase,
        screen: 'role_reveal' as GameScreen,
        acknowledged: false,
        acknowledgedCount: 0,
        currentAnnouncement: null,
      };
    });
  },

  setMyRole: (payload) => {
    // payload may be either { role } or the raw role object
    const role = payload && typeof payload === 'object'
      ? ('name' in payload && 'team' in payload
          ? payload
          : ('role' in payload ? payload.role ?? null : null))
      : null;
    set({ myRole: role });
  },

  applyPhase: (payload) => {
    const phasePayload: PhasePayload = 'phase' in payload ? payload : { phase: payload };
    const rawPhase = phasePayload.phase;
    const phase = buildPhase(rawPhase, {
      sub_phase: phasePayload.sub_phase,
      timer_seconds: phasePayload.timer_seconds,
      timer_started_at: phasePayload.timer_started_at,
    });
    if (!phase) {
      return;
    }
    const sessionStatus = phasePayload.session_status;
    const announcement: Announcement | null = phasePayload.announcement ?? null;

    // Поля action-окна (awaiting_action, action_type, available_targets) могут
    // отсутствовать в payload — например, для `game_resumed`, который шлёт
    // только phase + timer (action_required прилетит отдельным событием от
    // execute_night_sequence). В таком случае НЕ затираем текущее окно
    // нулями: иначе плашки игроков (availableTargets) исчезают сразу после
    // resume, и юзер не может выбрать жертву, пока не придёт action_required.
    //
    // НО: если phase ИДЕНТИЧНОСТЬ изменилась (тип/sub_phase/номер), то stale-state
    // из предыдущей фазы тащить нельзя — иначе после day_voting → night у не-актёров
    // остаётся awaitingAction=true и availableTargets=кандидаты из голосования,
    // и они видят NightActionScreen с карточками голосования вместо night_waiting.
    set((state) => {
      if (state.screen === 'finale' || state.result) return state;
      const phaseIdentityChanged =
        state.phase?.type !== phase.type ||
        (state.phase?.sub_phase ?? null) !== (phase.sub_phase ?? null) ||
        state.phase?.number !== phase.number;
      const awaitingActionFallback = phaseIdentityChanged ? false : state.awaitingAction;
      const actionTypeFallback: NightActionType | null = phaseIdentityChanged ? null : state.actionType;
      const targetsFallback: Target[] = phaseIdentityChanged ? [] : state.availableTargets;

      const awaitingAction: boolean =
        phasePayload.awaiting_action ?? awaitingActionFallback ?? false;
      const incomingActionType: NightActionType | null =
        phasePayload.action_type !== undefined ? phasePayload.action_type : actionTypeFallback;
      // `?? targetsFallback` покрывает оба случая отсутствия поля:
      // undefined (поле не отправлено backend'ом) И null (явно очищено).
      // Затирать `[]` нельзя в рамках одной фазы — иначе плашки исчезают после game_resumed.
      const incomingTargets: Target[] =
        phasePayload.available_targets ?? targetsFallback;

      const nextAnnouncement = resolveAnnouncement(state.currentAnnouncement, announcement);
      const sameActionWindow =
        actionWindowIdentity(state.phase, state.actionType) === actionWindowIdentity(phase, incomingActionType);
      const screen = applyAnnouncementScreen(
        deriveScreen(phase.type, phase.sub_phase, awaitingAction, sessionStatus),
        nextAnnouncement,
      );

      return {
        phase,
        screen,
        currentAnnouncement: nextAnnouncement,
        awaitingAction,
        actionType: incomingActionType,
        actionLabel: actionLabelFor(incomingActionType),
        availableTargets: incomingTargets,
        selectedTarget: sameActionWindow ? state.selectedTarget : null,
        actionSubmitted: sameActionWindow ? state.actionSubmitted : false,
        voteSubmitted:
          phase?.type === 'day' && phase?.sub_phase === 'voting' ? false : state.voteSubmitted,
        voteTarget:
          phase?.type === 'day' && phase?.sub_phase === 'voting' ? null : state.voteTarget,
        voteCounts:
          phase?.type === 'day' && phase?.sub_phase === 'voting' ? {} : state.voteCounts,
        nightNumber: phase?.type === 'night' ? phase.number : state.nightNumber,
        dayNumber: phase?.type === 'day' ? phase.number : state.dayNumber,
        storyVote:
          phase?.type === 'story_vote'
            ? {
                stories: phasePayload.stories ?? state.storyVote?.stories ?? [],
                counts: state.storyVote?.counts ?? {},
                voted: state.storyVote?.voted ?? 0,
                alive_total: state.storyVote?.alive_total ?? 0,
                my_vote: state.storyVote?.my_vote ?? null,
              }
            : state.storyVote,
        storyVoteSubmitted: phase?.type === 'story_vote' ? state.storyVoteSubmitted : false,
        storyVoteTarget: phase?.type === 'story_vote' ? state.storyVoteTarget : null,
        namePick:
          phase?.type === 'name_pick'
            ? {
                names: phasePayload.names ?? state.namePick?.names ?? [],
                taken: state.namePick?.taken ?? [],
                my_name: state.namePick?.my_name ?? null,
              }
            : state.namePick,
        namePickSubmitted:
          phase?.type === 'name_pick' ? state.namePickSubmitted : false,
      };
    });
  },

  applyActionRequired: (payload) => {
    const actionType: NightActionType | null = payload?.action_type ?? null;
    const availableTargets: Target[] = payload?.available_targets ?? [];
    const healRestriction = payload?.heal_restriction ?? null;
    set((state) => {
      if (state.screen === 'finale' || state.result) return state;
      const sameActionWindow =
        actionWindowIdentity(state.phase, state.actionType) ===
        actionWindowIdentity(
          {
            ...(state.phase ?? {}),
            timer_started_at: payload?.timer_started_at ?? state.phase?.timer_started_at ?? null,
          },
          actionType,
        );

      return {
        awaitingAction: true,
        actionType,
        actionLabel: actionLabelFor(actionType),
        availableTargets,
        selectedTarget: sameActionWindow ? state.selectedTarget : null,
        actionSubmitted: sameActionWindow ? state.actionSubmitted : false,
        healRestriction: sameActionWindow ? state.healRestriction ?? healRestriction : healRestriction,
        currentAnnouncement: null,
        screen: state.phase?.type === 'night' ? 'night_action' : state.screen,
      };
    });
  },

  applyActionBlocked: () => {
    set((state) => {
      if (state.screen === 'finale' || state.result) return state;
      return {
        awaitingAction: false,
        actionType: null,
        actionLabel: '',
        availableTargets: [],
        selectedTarget: null,
        actionSubmitted: false,
        currentAnnouncement: null,
        screen: state.phase?.type === 'night' ? 'night_waiting' : state.screen,
      };
    });
  },

  applyActionTimeout: (payload) => {
    const TURN_TO_ACTION: Record<string, NightActionType> = {
      lover: 'lover_visit',
      mafia: 'kill',
      don: 'don_check',
      sheriff: 'check',
      doctor: 'heal',
      maniac: 'maniac_kill',
    };
    const turnSlug = payload?.action_type as string | undefined;
    const mappedActionType = turnSlug ? TURN_TO_ACTION[turnSlug] : null;
    set((state) => {
      if (!state.awaitingAction) return state;
      if (mappedActionType && state.actionType === mappedActionType) {
        return {
          ...state,
          awaitingAction: false,
          selectedTarget: null,
          screen: 'night_waiting',
        };
      }
      return state;
    });
  },

  applyRoleAcknowledged: (payload) => {
    const acked = Number(payload?.players_acknowledged ?? 0);
    const total = payload?.players_total;
    set({
      acknowledgedCount: acked,
      ...(total != null ? { totalPlayers: Number(total) } : {}),
    });
  },

  applyAllAcknowledged: () => {
    set((state) => ({
      acknowledgedCount: state.totalPlayers,
    }));
  },

  applyNightResult: (payload) => {
    const died: { player_id: string; name: string }[] = payload?.died ?? [];
    const bpId = payload?.day_blocked_player ?? null;
    const announcement: Announcement | null = payload?.announcement ?? null;

    if (died.length === 0) {
      set((s) => {
        const nextAnnouncement = resolveAnnouncement(s.currentAnnouncement, announcement);
        const base = {
          nightKills: [] as NightKill[],
          nightResultDied: [] as { player_id: string; name: string }[],
          nightResultText: '',
          dayBlockedPlayer: bpId,
          currentAnnouncement: nextAnnouncement,
        };
        return hasBlockingAnnouncement(nextAnnouncement)
          ? { ...base, screen: 'narrator' as GameScreen }
          : base;
      });
      return;
    }

    // Single pass: build Set + nightKills + names
    const diedIds = new Set<string>();
    const nightKills: NightKill[] = [];
    const names: string[] = [];
    for (const d of died) {
      diedIds.add(d.player_id);
      nightKills.push({ player_id: d.player_id, name: d.name });
      names.push(d.name);
    }
    const killedNames = names.join(', ');

    set((s) => {
      const nextAnnouncement = resolveAnnouncement(s.currentAnnouncement, announcement);
      const base = {
        nightKills,
        nightResultDied: died,
        nightResultText: killedNames,
        dayBlockedPlayer: bpId,
        players: s.players.map((p) =>
          diedIds.has(p.id) ? { ...p, status: 'dead' as const } : p
        ),
        myStatus: (s.myPlayerId && diedIds.has(s.myPlayerId)) ? ('dead' as const) : s.myStatus,
        currentAnnouncement: nextAnnouncement,
      };
      return hasBlockingAnnouncement(nextAnnouncement)
        ? { ...base, screen: 'narrator' as GameScreen }
        : base;
    });
  },

  setVoteCounts: (payload) => {
    // Backend vote_update sends votes_cast / votes_total;
    // /state response sends votes.cast / votes.total_expected.
    const cast: number = payload?.votes_cast ?? payload?.cast ?? 0;
    const total: number = payload?.votes_total ?? payload?.total_expected ?? 0;
    const counts: Record<string, number> = payload?.counts ?? {};
    set((state) => ({
      votes: { total_expected: total || state.totalPlayers, cast },
      voteCounts: counts,
    }));
  },

  applyVoteResult: (payload) => {
    const eliminated = payload?.eliminated ?? null;
    const eliminatedId: string | null = eliminated?.player_id ?? payload?.eliminated_player_id ?? null;
    const announcement: Announcement | null = payload?.announcement ?? null;

    set((state) => {
      const nextAnnouncement = resolveAnnouncement(state.currentAnnouncement, announcement);
      const base: Partial<GameState> = { currentAnnouncement: nextAnnouncement };

      if (eliminatedId) {
        const idx = state.players.findIndex((p) => p.id === eliminatedId);
        if (idx !== -1 && state.players[idx].status !== 'dead') {
          const next = [...state.players];
          next[idx] = { ...next[idx], status: 'dead' };
          base.players = next;
          base.myStatus = state.myPlayerId === eliminatedId ? 'dead' : state.myStatus;
        }
      }

      return hasBlockingAnnouncement(nextAnnouncement)
        ? { ...base, screen: 'narrator' as GameScreen }
        : base;
    });
  },

  markEliminated: (playerId) => {
    set((state) => {
      const idx = state.players.findIndex((p) => p.id === playerId);
      if (idx === -1 || state.players[idx].status === 'dead') return state;
      const next = [...state.players];
      next[idx] = { ...next[idx], status: 'dead' };
      return {
        players: next,
        myStatus: state.myPlayerId === playerId ? 'dead' : state.myStatus,
      };
    });
  },

  setActionSubmitted: (value) => set({ actionSubmitted: value }),

  addCheckResult: (payload) => {
    const targetId = payload?.target_player_id ?? payload?.targetId;
    if (!targetId) return;
    const result: NightActionCheckResult = payload?.check_result ?? payload;
    const state = get();
    const actionType = payload?.action_type ?? state.actionType;
    if (!actionType) {
      return;
    }
    const entry = buildCheckResultEntry(targetId, actionType, result);
    set((s) => ({ checkResults: [...s.checkResults, entry] }));
  },

  queueAnnouncement: (payload) => {
    const announcement: Announcement | null =
      isAnnouncementEnvelope(payload) ? payload.announcement ?? null : payload;
    if (!announcement) {
      return;
    }
    set((state) => {
      const nextAnnouncement = resolveAnnouncement(state.currentAnnouncement, announcement);
      return {
        currentAnnouncement: nextAnnouncement,
        screen: nextAnnouncement?.blocking === false ? state.screen : 'narrator',
      };
    });
  },

  setResult: (payload) => {
    const winner = payload?.winner ?? null;
    const announcement: Announcement = payload?.announcement ?? {
      audio_url: '',
      text: '',
      duration_ms: 0,
    };
    const roster = payload?.final_roster ?? payload?.players ?? [];
    const result: GameResult = {
      winner,
      announcement,
      players: roster,
    };
    set({ result, screen: 'finale', currentAnnouncement: null });
    logger.info('game.result_received', 'Game result received', {
      sessionId: get().sessionId,
      winner,
    }, { sessionId: get().sessionId });
  },

  reset: () => set({ ...initialState }),
}));
