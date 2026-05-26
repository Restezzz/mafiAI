/**
 * Admin sessions hygiene API.
 * См. backend/api/routers/admin_sessions.py.
 */
import httpClient from './httpClient';

export interface AdminSessionItem {
  id: string;
  code: string;
  status: 'waiting' | 'active' | 'finished';
  player_count: number;
  players_joined: number;
  host_user_id: string;
  host_email: string;
  host_display_name: string;
  use_story_engine: boolean;
  story_id: string | null;
  is_dev_test_lobby: boolean;
  created_at: string;
  ended_at: string | null;
  last_phase_at: string | null;
  is_abandoned: boolean;
}

export interface AdminSessionsListResponse {
  sessions: AdminSessionItem[];
  total: number;
}

export interface CleanupResult {
  affected: number;
  ids: string[];
}

export interface ListParams {
  status?: 'waiting' | 'active' | 'finished' | 'active_all';
  abandoned_only?: boolean;
  dev_test_lobby_only?: boolean;
  limit?: number;
  offset?: number;
}

export const adminSessionsApi = {
  list: (params: ListParams = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.abandoned_only) q.set('abandoned_only', 'true');
    if (params.dev_test_lobby_only) q.set('dev_test_lobby_only', 'true');
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString();
    return httpClient.get<AdminSessionsListResponse>(
      `/admin/sessions${qs ? '?' + qs : ''}`,
    );
  },
  close: (sessionId: string) =>
    httpClient.post<AdminSessionItem>(`/admin/sessions/${sessionId}/close`),
  remove: (sessionId: string) =>
    httpClient.delete<{ deleted: boolean; id: string }>(
      `/admin/sessions/${sessionId}`,
    ),
  cleanupAbandoned: () =>
    httpClient.post<CleanupResult>('/admin/cleanup/abandoned-sessions'),
  cleanupSynthetic: () =>
    httpClient.post<CleanupResult>('/admin/cleanup/synthetic-users'),
};
