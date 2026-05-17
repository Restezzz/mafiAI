import httpClient from './httpClient';
import {
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  RefreshRequest,
  RefreshResponse,
  UserProfile,
  LogoutRequest,
  UpdateNicknameRequest,
  UpdateAvatarRequest,
  DeleteAccountRequest,
} from '../types/api';

export const authApi = {
  register: (data: RegisterRequest) =>
    httpClient.post<AuthResponse>('/auth/register', data),

  login: (data: LoginRequest) =>
    httpClient.post<AuthResponse>('/auth/login', data),

  refresh: (data: RefreshRequest) =>
    httpClient.post<RefreshResponse>('/auth/refresh', data),

  me: () =>
    httpClient.get<UserProfile>('/auth/me'),

  logout: (data: LogoutRequest) =>
    httpClient.post('/auth/logout', data),

  updateNickname: (data: UpdateNicknameRequest) =>
    httpClient.patch<UserProfile>('/auth/me', data),

  updateAvatar: (data: UpdateAvatarRequest) =>
    httpClient.put<UserProfile>('/auth/me/avatar', data),

  deleteAccount: (data: DeleteAccountRequest) =>
    httpClient.delete('/auth/me', { data }),
};
