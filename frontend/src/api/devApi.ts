import httpClient from './httpClient';
import type {
  ActivateDevPlayerRequest,
  ActivateDevPlayerResponse,
  SessionDetailResponse,
} from '../types/api';

export const devApi = {
  createTestLobby: () =>
    httpClient.post<SessionDetailResponse>('/dev/test-lobbies'),

  expandTestLobby: (sessionId: string) =>
    httpClient.post<SessionDetailResponse>(`/dev/test-lobbies/${sessionId}/expand`),

  shrinkTestLobby: (sessionId: string) =>
    httpClient.post<SessionDetailResponse>(`/dev/test-lobbies/${sessionId}/shrink`),

  activatePlayer: (data: ActivateDevPlayerRequest) =>
    httpClient.post<ActivateDevPlayerResponse>('/dev/test-lobbies/activate', data),
};
