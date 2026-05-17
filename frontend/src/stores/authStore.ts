import { create } from 'zustand';
import { UserProfile } from '../types/api';
import { authApi } from '../api/authApi';
import { refreshAccessToken } from '../api/httpClient';
import { AuthStorageMode, getRefreshToken, removeRefreshToken, setRefreshToken } from '../utils/tokenStorage';
import { clearAudioPreloadCache } from '../utils/audioPreloader';
import { logger } from '../services/logger';

interface AuthState {
  accessToken: string | null;
  user: UserProfile | null;
  isAuthenticated: boolean;
  isInitializing: boolean;

  setTokens: (accessToken: string, refreshToken: string, mode?: AuthStorageMode) => void;
  setUser: (user: UserProfile) => void;
  logout: () => Promise<void>;
  initialize: () => Promise<void>; // Auto-login по refresh-токену при старте приложения
}

/** Внутренний флаг против рекурсии logout (httpClient interceptor → logout → logout → ...). */
let logoutInProgress = false;

export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,
  // Пока идёт первичный restore (refresh + me) — рендерим splash, чтобы ProtectedRoute
  // не отправил пользователя на /auth раньше времени.
  isInitializing: true,

  setTokens: (accessToken, refreshToken, mode = 'local') => {
    setRefreshToken(refreshToken, mode);
    set({ accessToken, isAuthenticated: true });
  },

  setUser: (user) => set({ user }),

  logout: async () => {
    if (logoutInProgress) return;
    logoutInProgress = true;
    try {
      // Попытаться честно инвалидировать refresh-токен на бэке (не критично, ошибки глушим).
      const refreshToken = getRefreshToken();
      if (refreshToken) {
        try {
          await authApi.logout({ refresh_token: refreshToken });
        } catch {
          // ignore — локальный логаут всё равно должен сработать
        }
      }
      removeRefreshToken();
      // Освобождаем blob: URL'ы озвучки — иначе при logout они держатся
      // в памяти браузера до полной перезагрузки страницы.
      clearAudioPreloadCache();
      set({ accessToken: null, user: null, isAuthenticated: false });
      logger.info('auth.logout_success', 'User logged out on frontend');
    } finally {
      logoutInProgress = false;
    }
  },

  initialize: async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
      set({ isInitializing: false });
      return;
    }
    try {
      // Use the shared deduped refresh to avoid race with httpClient interceptor.
      await refreshAccessToken();

      const meResponse = await authApi.me();
      set({ user: meResponse.data });
      logger.info('auth.initialize_success', 'Auth session restored from refresh token');
    } catch {
      // Невалидный/истёкший refresh — чистим всё и отправляем на /auth.
      removeRefreshToken();
      set({ accessToken: null, user: null, isAuthenticated: false });
      logger.warn('auth.initialize_failed', 'Failed to restore auth session from refresh token');
    } finally {
      set({ isInitializing: false });
    }
  },
}));
