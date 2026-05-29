import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '../stores/authStore';
import { getAuthStorageMode, getRefreshToken } from '../utils/tokenStorage';
import { API_BASE_URL } from '../utils/constants';
import { logger, nextClientRequestId } from '../services/logger';

const httpClient = axios.create({
  baseURL: `${API_BASE_URL}/api`,
});

// Флаг, предотвращающий параллельные refresh-запросы
let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (token) resolve(token);
    else reject(error);
  });
  failedQueue = [];
}

/**
 * Shared refresh function used by both the interceptor and authStore.initialize().
 * Deduped: concurrent callers share the same in-flight promise.
 */
export async function refreshAccessToken(): Promise<string> {
  if (isRefreshing && refreshPromise) return refreshPromise;

  isRefreshing = true;
  logger.warn('auth.refresh_retry', 'Refreshing access token after authorization failure');
  refreshPromise = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) throw new Error('No refresh token');
    const { data } = await axios.post(
      `${API_BASE_URL}/api/auth/refresh`,
      { refresh_token: refreshToken },
    );
    useAuthStore.getState().setTokens(data.access_token, data.refresh_token, getAuthStorageMode());
    return data.access_token as string;
  })();

  try {
    const token = await refreshPromise;
    processQueue(null, token);
    return token;
  } catch (err) {
    processQueue(err, null);
    throw err;
  } finally {
    isRefreshing = false;
    refreshPromise = null;
  }
}

// Request interceptor — добавляет токен
httpClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const accessToken = useAuthStore.getState().accessToken;
  const clientRequestId = config.headers['X-Client-Request-ID']?.toString() || nextClientRequestId();
  config.headers['X-Client-Request-ID'] = clientRequestId;
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  logger.debug('api.request_prepared', 'HTTP request prepared', {
    method: config.method,
    url: config.url,
  }, {
    clientRequestId,
  });
  return config;
});

// Response interceptor — auto-refresh при 401
httpClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    const skipUrls = ['/auth/login', '/auth/register', '/auth/refresh', '/dev/test-lobbies/activate'];

    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !skipUrls.some((url) => originalRequest.url?.includes(url))
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({
            resolve: (token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              resolve(httpClient(originalRequest));
            },
            reject,
          });
        });
      }

      originalRequest._retry = true;

      try {
        const newToken = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return httpClient(originalRequest);
      } catch (refreshError) {
        // Если другой параллельный refresh уже успешно обновил токены,
        // не разлогиниваем — просто повторяем запрос с новым токеном.
        const currentToken = useAuthStore.getState().accessToken;
        const headerToken = originalRequest.headers.Authorization?.toString().replace('Bearer ', '');
        if (currentToken && currentToken !== headerToken) {
          originalRequest.headers.Authorization = `Bearer ${currentToken}`;
          return httpClient(originalRequest);
        }
        logger.warn('auth.force_logout_after_refresh_failure', 'Forced logout after refresh failure', {
          url: originalRequest.url,
          status: error.response?.status,
        });
        useAuthStore.getState().logout();
        window.location.href = '/auth';
        return Promise.reject(refreshError);
      }
    }

    logger.warn('api.nonfatal_failure', 'HTTP request failed', {
      method: originalRequest?.method,
      url: originalRequest?.url,
      status: error.response?.status,
      code: error.code,
    }, {
      clientRequestId: originalRequest?.headers?.['X-Client-Request-ID']?.toString(),
    });

    return Promise.reject(error);
  }
);

export default httpClient;
