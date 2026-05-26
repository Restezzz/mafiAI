import { useGameStore } from './gameStore';
import { gameApi } from '../api/gameApi';
import { GameStateResponse } from '../types/api';

jest.mock('../api/gameApi', () => ({
  gameApi: {
    getState: jest.fn(),
  },
}));

describe('gameStore role reveal sync', () => {
  beforeEach(() => {
    useGameStore.getState().reset();
    jest.clearAllMocks();
  });

  it('updates both acknowledged count and total players from websocket payload', () => {
    useGameStore.getState().applyRoleAcknowledged({
      players_acknowledged: 2,
      players_total: 5,
    });

    const state = useGameStore.getState();
    expect(state.acknowledgedCount).toBe(2);
    expect(state.totalPlayers).toBe(5);
  });

  it('forces N/N after all players acknowledged', () => {
    useGameStore.setState({ totalPlayers: 5, acknowledgedCount: 3 });

    useGameStore.getState().applyAllAcknowledged();

    expect(useGameStore.getState().acknowledgedCount).toBe(5);
  });

  it('keeps active session without phase in syncing instead of role reveal', async () => {
    (gameApi.getState as jest.Mock).mockResolvedValue({
      data: {
        session_status: 'active',
        game_paused: false,
        settings: {},
        phase: {
          id: '',
          type: null,
          number: 0,
          sub_phase: null,
          started_at: '',
          timer_seconds: null,
          timer_started_at: null,
          vote_round: 1,
        },
        my_player: {
          id: 'p1',
          name: 'Игрок',
          status: 'alive',
          role: { slug: 'doctor', name: 'Доктор', team: 'city', abilities: { night_action: 'heal' } },
        },
        players: [{ id: 'p1', name: 'Игрок', status: 'alive', join_order: 1 }],
        role_reveal: null,
        awaiting_action: false,
        action_type: null,
        available_targets: [],
        my_action_submitted: false,
        votes: null,
        result: null,
        announcement: null,
      } as unknown as GameStateResponse,
    });

    await useGameStore.getState().loadState('session-1');

    expect(useGameStore.getState().screen).toBe('syncing');
  });

  it('ignores stale game_started when active phase is already in progress', () => {
    useGameStore.setState({
      phase: {
        id: 'phase-1',
        type: 'night',
        number: 1,
        sub_phase: null,
        started_at: '2026-04-14T12:00:00.000Z',
        timer_seconds: 30,
        timer_started_at: '2026-04-14T12:00:00.000Z',
      },
      screen: 'night_waiting',
      acknowledged: true,
      acknowledgedCount: 5,
    });

    useGameStore.getState().onGameStarted({
      phase: { type: 'role_reveal', number: 0 },
      timer_seconds: 15,
      started_at: '2026-04-14T11:00:00.000Z',
    });

    expect(useGameStore.getState().screen).toBe('night_waiting');
    expect(useGameStore.getState().phase?.type).toBe('night');
  });

  it('preserves submitted night action on identical resync', async () => {
    useGameStore.setState({
      phase: {
        id: 'night-1',
        type: 'night',
        number: 1,
        sub_phase: null,
        started_at: '2026-04-14T12:00:00.000Z',
        timer_seconds: 25,
        timer_started_at: '2026-04-14T12:00:00.000Z',
      },
      screen: 'night_action',
      actionType: 'kill',
      actionSubmitted: true,
      selectedTarget: 'p2',
    });

    (gameApi.getState as jest.Mock).mockResolvedValue({
      data: {
        session_status: 'active',
        game_paused: false,
        settings: {},
        phase: {
          id: 'night-1',
          type: 'night',
          number: 1,
          sub_phase: null,
          started_at: '2026-04-14T12:00:00.000Z',
          timer_seconds: 25,
          timer_started_at: '2026-04-14T12:00:00.000Z',
        },
        my_player: {
          id: 'p1',
          name: 'Игрок',
          status: 'alive',
          role: { slug: 'mafia', name: 'Мафия', team: 'mafia', abilities: { night_action: 'kill' } },
        },
        players: [
          { id: 'p1', name: 'Игрок', status: 'alive', join_order: 1 },
          { id: 'p2', name: 'Жертва', status: 'alive', join_order: 2 },
        ],
        role_reveal: null,
        awaiting_action: true,
        action_type: 'kill',
        available_targets: [{ player_id: 'p2', name: 'Жертва' }],
        my_action_submitted: true,
        votes: null,
        result: null,
        announcement: null,
      },
    });

    await useGameStore.getState().loadState('session-1');

    const state = useGameStore.getState();
    expect(state.screen).toBe('night_action');
    expect(state.actionSubmitted).toBe(true);
    expect(state.selectedTarget).toBe('p2');
  });

  it('does not reset submitted action for duplicate action_required payload', () => {
    useGameStore.setState({
      phase: {
        id: 'night-1',
        type: 'night',
        number: 1,
        sub_phase: null,
        started_at: '2026-04-14T12:00:00.000Z',
        timer_seconds: 25,
        timer_started_at: '2026-04-14T12:00:00.000Z',
      },
      screen: 'night_action',
      actionType: 'heal',
      actionSubmitted: true,
      selectedTarget: 'p2',
    });

    useGameStore.getState().applyActionRequired({
      action_type: 'heal',
      timer_started_at: '2026-04-14T12:00:00.000Z',
      available_targets: [{ player_id: 'p2', name: 'Игрок 2' }],
    });

    const state = useGameStore.getState();
    expect(state.actionSubmitted).toBe(true);
    expect(state.selectedTarget).toBe('p2');
  });

  it('keeps current screen for non-blocking queued announcements', () => {
    useGameStore.setState({
      screen: 'day_discussion',
      currentAnnouncement: null,
    });

    useGameStore.getState().queueAnnouncement({
      announcement: {
        text: 'Фоновая реплика',
        duration_ms: 1200,
        blocking: false,
      },
    });

    const state = useGameStore.getState();
    expect(state.currentAnnouncement?.text).toBe('Фоновая реплика');
    expect(state.screen).toBe('day_discussion');
  });

  it('resets stale awaitingAction and availableTargets on phase transition', () => {
    // Bug regression: after day voting (per-user phase_changed sets
    // awaiting_action=true, available_targets=[...]) → night start
    // (broadcast phase_changed without these fields). Без сброса
    // не-актёры видели NightActionScreen с карточками голосования.
    useGameStore.setState({
      phase: {
        id: 'phase-day-1',
        type: 'day',
        number: 1,
        sub_phase: 'voting',
        started_at: '2026-04-14T12:00:00.000Z',
        timer_seconds: 30,
        timer_started_at: '2026-04-14T12:00:00.000Z',
      },
      screen: 'day_voting',
      awaitingAction: true,
      availableTargets: [
        { player_id: 'p2', name: 'Жертва' },
        { player_id: 'p3', name: 'Игрок 3' },
      ],
    });

    // Backend broadcasts phase_changed for night without
    // awaiting_action/available_targets — non-actors must not retain stale state.
    useGameStore.getState().applyPhase({
      phase: { type: 'night', number: 2 },
      timer_seconds: 25,
      timer_started_at: '2026-04-14T12:01:00.000Z',
    });

    const state = useGameStore.getState();
    expect(state.awaitingAction).toBe(false);
    expect(state.availableTargets).toEqual([]);
    expect(state.screen).toBe('night_waiting');
  });

  it('preserves availableTargets within the same phase (game_resumed scenario)', () => {
    // Регрессионный тест: game_resumed шлёт phase + timer без action-полей.
    // В рамках одной фазы (sameActionWindow) state.availableTargets должен
    // сохраняться, иначе плашки исчезают сразу после resume.
    useGameStore.setState({
      phase: {
        id: 'night-1',
        type: 'night',
        number: 1,
        sub_phase: null,
        started_at: '2026-04-14T12:00:00.000Z',
        timer_seconds: 25,
        timer_started_at: '2026-04-14T12:00:00.000Z',
      },
      screen: 'night_action',
      awaitingAction: true,
      actionType: 'kill',
      availableTargets: [{ player_id: 'p2', name: 'Жертва' }],
    });

    // game_resumed — та же фаза, без action-полей.
    useGameStore.getState().applyPhase({
      phase: { type: 'night', number: 1 },
      timer_seconds: 20,
      timer_started_at: '2026-04-14T12:00:00.000Z',
    });

    const state = useGameStore.getState();
    expect(state.awaitingAction).toBe(true);
    expect(state.availableTargets).toEqual([{ player_id: 'p2', name: 'Жертва' }]);
    expect(state.actionType).toBe('kill');
  });
});
