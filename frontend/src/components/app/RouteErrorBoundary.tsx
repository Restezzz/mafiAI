import { useEffect } from 'react';
import { useRouteError, useNavigate } from 'react-router-dom';
import Button from '../ui/Button';
import { logger } from '../../services/logger';

/**
 * Route-level ErrorBoundary (#26).
 *
 * React Router v7 data routers поддерживают `errorElement` на каждом route —
 * exception внутри страницы не разваливает SPA целиком, а заменяется на этот
 * компонент. Корневой `<AppErrorBoundary>` остаётся как safety-net на ошибки
 * вне route-tree (auth init, RouterProvider boot и т.д.).
 *
 * Логируем как `route.error` чтобы отделять от bootstrap-падений.
 */
export default function RouteErrorBoundary() {
  const error = useRouteError() as unknown;
  const navigate = useNavigate();

  useEffect(() => {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('route.error', 'Route error boundary caught an error', {
      message: err.message,
      stack: err.stack,
    });
  }, [error]);

  return (
    <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', padding: '24px' }}>
      <div style={{ maxWidth: '420px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <h2 style={{ margin: 0 }}>Что-то пошло не так</h2>
        <p style={{ margin: 0, opacity: 0.8 }}>
          Страница не открылась из-за ошибки. Попробуйте вернуться на главную или обновить страницу.
        </p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <Button onClick={() => navigate('/')}>На главную</Button>
          <Button onClick={() => window.location.reload()}>Обновить</Button>
        </div>
      </div>
    </div>
  );
}
