export interface Role {
  slug?: string;         // backend stable identifier: "mafia", "don", "sheriff", ...
  name: string;          // "Мафия", "Шериф", "Доктор", "Мирный", "Дон"
  team: 'mafia' | 'city' | 'maniac';
  abilities?: {
    night_action: 'kill' | 'check' | 'heal' | 'don_check' | 'lover_visit' | 'maniac_kill' | null;
  };
}

export interface Player {
  id: string;            // UUID (player_id)
  name: string;
  /**
   * Никнейм аккаунта (User.display_name) — отображается второй строкой
   * под игровым именем в голосовании/ночных меню. Optional — бэк может
   * вернуть null, если игрок не подгружен или деплоился старый бэк.
   */
  username?: string | null;
  status: 'alive' | 'dead';
  join_order: number;
}

export interface PlayerWithRole extends Player {
  role: { slug?: string; name: string; team: 'mafia' | 'city' | 'maniac' };
}

export interface Phase {
  id: string;
  type: 'role_reveal' | 'night' | 'day';
  number: number;
  sub_phase: 'discussion' | 'voting' | null;
  started_at: string;         // ISO 8601
  timer_seconds: number | null;
  timer_started_at: string | null; // ISO 8601
  vote_round?: number;
}

export interface AudioSegment {
  url: string;
  duration_ms: number;
}

export interface Announcement {
  audio_url?: string | null;
  // Для name_pair (склейка opener → имя → closer) — клиент проигрывает
  // последовательно. Если задан — audio_url игнорируется. duration_ms суммарный.
  audio_segments?: AudioSegment[];
  // Имя файла (или склейка имён через ", ") — для дев-оверлея и /ui.
  audio_file_name?: string;
  text: string;
  duration_ms: number;
  key?: string;
  trigger?: string;
  step_index?: number;
  steps_total?: number;
  blocking?: boolean;
  seed?: number;
  // ISO8601, момент когда сервер начал «озвучивать» — нужен для синхронизации
  // typewriter/прогресс-бара между клиентами и при reload/перезаходе на страницу.
  started_at?: string;
  // Story Engine: если true, NarratorScreen рендерит подсветку слов (karaoke)
  // вместо per-char typewriter'а. Equally-spaced распределение по словам —
  // duration_ms / words.length мс на слово. Источник: story.settings.karaoke_enabled
  // прокидывается в _build_narration_steps. Legacy путь не задаёт это поле
  // (остаётся undefined → per-char typewriter).
  karaoke?: boolean;
}

export interface MyPlayer {
  id: string;
  name: string;
  status: 'alive' | 'dead';
  role: Role;
}

export interface Target {
  player_id: string;
  name: string;
  /** Никнейм (User.display_name) — рисуется под name в меню выбора. */
  username?: string | null;
}

export interface RoleRevealInfo {
  my_acknowledged: boolean;
  players_acknowledged: number;
  players_total: number;
}

export interface VoteInfo {
  total_expected: number;
  cast: number;
}

export interface GameResult {
  winner: 'mafia' | 'city' | 'maniac' | null;
  announcement: Announcement;
  players: PlayerWithRole[];
}

export interface RoleConfig {
  mafia: number;     // 0–2
  don: number;       // 0–2
  sheriff: number;   // 0–2
  doctor: number;    // 0–2
  lover: number;     // 0–2
  maniac: number;    // 0–2
}

export interface SessionSettings {
  role_reveal_timer_seconds: number;
  discussion_timer_seconds: number;
  voting_timer_seconds: number;
  night_action_timer_seconds: number;
  role_config: RoleConfig;
  dev_test_lobby?: boolean;
  // Story Engine (этап 2.6): включён ли альтернативный gameplay flow.
  // story_id хранится отдельной FK-колонкой sessions.story_id, но
  // прокидывается через тот же settings-form для удобства UI.
  use_story_engine?: boolean;
  story_id?: string | null;
  // Story Engine pre-game overrides (этап 3). Накладываются поверх
  // story.settings.{timer_multiplier_default, inter_cue_pause_seconds}.
  // null/undefined = «использовать дефолт сюжета».
  timer_multiplier?: number | null;
  inter_cue_pause_seconds?: number | null;
}

export interface DevLobbyPlayerLink {
  slot_number: number;
  player_slug: string;
  player_name: string;
  url: string;
}

export interface DevLobbyInfo {
  is_test_lobby: boolean;
  player_links?: DevLobbyPlayerLink[] | null;
}

export interface Session {
  id: string;
  code: string;
  host_user_id: string;
  player_count: number;
  status: 'waiting' | 'active' | 'finished';
  settings: SessionSettings;
  created_at: string;
  dev_lobby?: DevLobbyInfo | null;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  /** Никнейм аккаунта — вторая строка под игровым именем в лобби. */
  username?: string | null;
  join_order: number;
  is_host: boolean;
}
