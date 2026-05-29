import httpClient from './httpClient';
import type {
  StartSessionResponse,
  AcknowledgeRoleResponse,
  NightActionRequest,
  NightActionResponse,
  VoteRequest,
  VoteResponse,
  GameStateResponse,
} from '../types/api';

export const gameApi = {
  start: (sessionId: string) =>
    httpClient.post<StartSessionResponse>(`/sessions/${sessionId}/start`),

  acknowledgeRole: (sessionId: string) =>
    httpClient.post<AcknowledgeRoleResponse>(`/sessions/${sessionId}/acknowledge-role`),

  nightAction: (sessionId: string, target_player_id: string) => {
    const body: NightActionRequest = { target_player_id };
    return httpClient.post<NightActionResponse>(`/sessions/${sessionId}/night-action`, body);
  },

  vote: (sessionId: string, target_player_id: string | null) => {
    const body: VoteRequest = { target_player_id };
    return httpClient.post<VoteResponse>(`/sessions/${sessionId}/vote`, body);
  },

  storyVote: (sessionId: string, story_id: string) =>
    httpClient.post<{ status: string }>(`/sessions/${sessionId}/story-vote`, { story_id }),

  namePick: (sessionId: string, name: string) =>
    httpClient.post<{ ok: boolean }>(`/sessions/${sessionId}/name-pick`, { name }),

  getState: (sessionId: string) =>
    httpClient.get<GameStateResponse>(`/sessions/${sessionId}/state`),

  resetToLobby: (sessionId: string) =>
    httpClient.post<{ status: string; session_code: string }>(`/sessions/${sessionId}/reset-to-lobby`),
};
