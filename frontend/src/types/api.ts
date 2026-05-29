import {
  Session,
  SessionSettings,
  LobbyPlayer,
  Phase,
  MyPlayer,
  Player,
  RoleRevealInfo,
  Target,
  VoteInfo,
  GameResult,
  RoleConfig,
  DevLobbyInfo,
  StoryVoteInfo,
  NamePickInfo,
} from './game';

// ---- Auth ----

export interface RegisterRequest {
  email: string;
  password: string;
  nickname: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  user_id: string;
  email: string;
  nickname: string;
  access_token: string;
  refresh_token: string;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
}

export interface UserProfile {
  user_id: string;
  email: string;
  nickname: string;
  has_pro: boolean;
  // Доступ к админ-панели narrator. Возвращается /auth/me; при ручной
  // конструкции после register/login считаем false (новый юзер не админ).
  is_admin?: boolean;
  created_at: string;
  avatar_url?: string | null;
}

export interface LogoutRequest {
  refresh_token: string;
}

export interface UpdateNicknameRequest {
  nickname: string;
}

export interface UpdateAvatarRequest {
  avatar_data_url: string | null;
}

export interface DeleteAccountRequest {
  password: string;
}

// ---- Sessions ----

export interface CreateSessionRequest {
  player_count: number;
  settings: SessionSettings;
  host_name?: string;
}

export interface SessionResponse extends Session {}

/** alias для обратной совместимости с старыми импортами */
export interface CreateSessionResponse extends Session {}

export interface PlayerInList {
  id: string;
  name: string;
  /** Никнейм аккаунта (User.display_name) — отрисовывается под name в UI. */
  username?: string | null;
  join_order: number;
  is_host: boolean;
  is_me: boolean;
}

export interface SessionDetailResponse extends Session {
  players: PlayerInList[];
  dev_lobby?: DevLobbyInfo | null;
}

/** alias — некоторые файлы импортируют это имя */
export interface GetSessionResponse extends SessionDetailResponse {}

export interface JoinSessionRequest {
  name?: string | null;
}

export interface JoinSessionResponse {
  player_id: string;
  session_id: string;
  join_order: number;
}

export interface GetPlayersResponse {
  players: PlayerInList[];
}

export interface UpdateSettingsRequest {
  role_reveal_timer_seconds?: number;
  discussion_timer_seconds?: number;
  voting_timer_seconds?: number;
  night_action_timer_seconds?: number;
  role_config?: Partial<RoleConfig>;
  // Story Engine (этап 2.6).
  use_story_engine?: boolean;
  story_id?: string | null;
  // Story Engine pre-game overrides (этап 3).
  timer_multiplier?: number | null;
  inter_cue_pause_seconds?: number | null;
}

export interface UpdateSettingsResponse {
  settings: SessionSettings;
}

export interface AudioPreloadStatusResponse {
  manifest_version: string;
  required: boolean;
  audio_count: number;
  ready_count: number;
  players_total: number;
  ready_player_ids: string[];
}

export interface AudioPreloadReadyRequest {
  manifest_version: string;
}

export interface ActivateDevPlayerRequest {
  code: string;
  player_slug: string;
  bootstrap_key: string;
}

export interface ActivateDevPlayerResponse {
  access_token: string;
  refresh_token: string;
  user: UserProfile;
}

export interface StartSessionResponse {
  status: 'active';
  phase: {
    type: 'role_reveal' | 'story_vote' | 'name_pick';
    number: number;
  };
}

// ---- Game ----

/** Тип ночного/дневного действия. Голосование — виртуальное значение для UI. */
export type ActionType =
  | 'kill'
  | 'check'
  | 'heal'
  | 'don_check'
  | 'lover_visit'
  | 'maniac_kill'
  | 'vote';

export interface GameStateResponse {
  session_status: 'active' | 'finished';
  session_code?: string;
  game_paused: boolean;
  phase: Phase;
  announcement?: GameResult['announcement'] | null;
  my_player: MyPlayer & {
    is_blocked_tonight?: boolean;
  };
  players: Player[];
  role_reveal: RoleRevealInfo | null;
  story_vote?: StoryVoteInfo | null;
  name_pick?: NamePickInfo | null;
  awaiting_action: boolean;
  action_type: Exclude<ActionType, 'vote'> | null;
  available_targets: Target[] | null;
  my_action_submitted: boolean;
  votes: VoteInfo | null;
  day_blocked_player?: string | null;
  result: GameResult | null;
}

export interface AcknowledgeRoleResponse {
  acknowledged: true;
  players_acknowledged: number;
  players_total: number;
}

export interface NightActionRequest {
  target_player_id: string;
}

export interface NightActionCheckResult {
  /** для обычной проверки шерифа */
  team?: 'mafia' | 'city' | 'maniac';
  /** для проверки дона — true, если цель шериф */
  is_sheriff?: boolean;
  /** альтернативный короткий формат для дона */
  match?: boolean;
}

export interface NightActionResponse {
  action_type: 'kill' | 'check' | 'heal' | 'don_check' | 'lover_visit' | 'maniac_kill';
  target_player_id: string;
  confirmed: true;
  check_result?: NightActionCheckResult;
}

export interface VoteRequest {
  target_player_id: string | null;
}

export interface VoteResponse {
  voter_player_id: string;
  target_player_id: string | null;
  confirmed: true;
}

export interface RematchRequest {
  keep_players: boolean;
  settings?: Partial<SessionSettings>;
}

export interface RematchResponse {
  new_session_id: string;
  code: string;
  status: 'waiting' | 'active';
  players_kept: number;
}

// ---- Subscriptions ----

export type SubscriptionPlan = 'free' | 'pro';
export type SubscriptionStatus = 'active' | 'cancelled' | 'expired' | 'none';

export interface SubscriptionStatusResponse {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface CreateSubscriptionRequest {
  plan: 'pro';
}

export interface CreateSubscriptionResponse {
  subscription_id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  period_start: string;
  period_end: string;
}
