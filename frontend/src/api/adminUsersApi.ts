import httpClient from './httpClient';

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  created_at: string | null;
}

export interface AdminUsersListResponse {
  users: AdminUser[];
  total: number;
}

// Axios baseURL = `${API_BASE_URL}/api`, поэтому путь относительный корня /api.
const BASE = '/admin/users';

export const adminUsersApi = {
  list: (params?: { q?: string; limit?: number; offset?: number }) =>
    httpClient.get<AdminUsersListResponse>(BASE, { params }),

  promote: (userId: string) =>
    httpClient.post<AdminUser>(`${BASE}/${userId}/promote`),

  demote: (userId: string) =>
    httpClient.post<AdminUser>(`${BASE}/${userId}/demote`),

  /** Quick-form: выдать админа по email без поиска. LOWER(email) на бекенде. */
  promoteByEmail: (email: string) =>
    httpClient.post<AdminUser>(`${BASE}/promote-by-email`, { email }),

  /** Физически удаляет юзера и его зависимости (сессии-хоста, подписки, players). */
  remove: (userId: string) =>
    httpClient.delete<{ deleted: boolean; id: string }>(`${BASE}/${userId}`),
};
