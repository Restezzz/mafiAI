import React, { lazy, Suspense, useEffect } from 'react';
import { createBrowserRouter, RouterProvider, Navigate, type RouteObject } from 'react-router-dom';
// Eager: лендинг и auth — нужны сразу при первом заходе.
import AuthPage from './pages/AuthPage';
import LandingPage from './pages/LandingPage';
import Loader from './components/ui/Loader';
import AppErrorBoundary from './components/app/AppErrorBoundary';
import RouteErrorBoundary from './components/app/RouteErrorBoundary';
import { useAuthStore } from './stores/authStore';
import { prepareAuthStorageFromLocation } from './utils/tokenStorage';
import { setAppRouter } from './utils/routerRef';
import { logger } from './services/logger';
import './App.scss';

// Lazy-load: всё что не открывается на первом визите.
// React.lazy + Suspense — webpack делает отдельный chunk на каждую страницу.
// Это режет main bundle на ~30-50% и ускоряет landing page (gsap, sass и т.д.
// больше не блокируют первый рендер).
const HomePage = lazy(() => import('./pages/HomePage'));
const PricingPage = lazy(() => import('./pages/PricingPage'));
const LobbyPage = lazy(() => import('./pages/LobbyPage'));
const StorySelectionPage = lazy(() => import('./pages/StorySelectionPage'));
const GamePage = lazy(() => import('./pages/GamePage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const DevPlayerBootstrapPage = lazy(() => import('./pages/DevPlayerBootstrapPage'));

// Admin (narrator) панель — отдельный lazy-chunk, грузится только при /admin/*.
const AdminPage = lazy(() => import('./pages/AdminPage'));
const AdminOverviewPage = lazy(() => import('./pages/admin/AdminOverviewPage'));
const TriggersListPage = lazy(() => import('./pages/admin/TriggersListPage'));
const TriggerDetailPage = lazy(() => import('./pages/admin/TriggerDetailPage'));
const TriggerCreatePage = lazy(() => import('./pages/admin/TriggerCreatePage'));

// Dev-only UI showcase page. В production-build lazy-импорт dead-code-elim-ится
// благодаря NODE_ENV-гварду (Terser). `process.env.NODE_ENV` — единственный
// паттерн, который CRA/react-scripts надёжно распознаёт для tree-shaking.
let DevUiPage: React.LazyExoticComponent<React.ComponentType> | null = null;
if (process.env.NODE_ENV !== 'production') {
  DevUiPage = lazy(() => import('./pages/UiPage'));
}

/** Общий fallback для Suspense — центрированный лоадер. */
function PageFallback() {
  return (
    <div className="app-bootstrap">
      <Loader size={48} />
    </div>
  );
}

/** Обёртка для lazy-роутов: <Suspense fallback={<Loader/>}>{element}</Suspense>. */
function withSuspense(element: React.ReactNode): React.ReactNode {
  return <Suspense fallback={<PageFallback />}>{element}</Suspense>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated) {
    return <Navigate to="/auth" replace />;
  }

  return <>{children}</>;
}

/**
 * AdminRoute — гейтирует /admin/* по флагу `user.is_admin` (см. /api/auth/me).
 * Неавторизованного отправляет на /auth, авторизованного-не-админа — на /app.
 */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  if (!isAuthenticated) {
    return <Navigate to="/auth" replace />;
  }
  if (!user?.is_admin) {
    return <Navigate to="/app" replace />;
  }
  return <>{children}</>;
}

// Data router (createBrowserRouter) обязателен для useBlocker в react-router-dom v7.
// Обычный <BrowserRouter> / <Routes> — legacy, useBlocker в нём бросает invariant.
// #26: errorElement подключён к каждому route. Exception в одной странице
// не валит весь SPA — react-router рендерит RouteErrorBoundary локально
// вместо element, остальные роуты остаются работоспособными.
const errorElement = <RouteErrorBoundary />;

const devRoutes: RouteObject[] = DevUiPage
  ? [
      {
        path: '/ui',
        element: withSuspense(<DevUiPage />),
        errorElement,
      },
    ]
  : [];

const router = createBrowserRouter([
  { path: '/', element: <LandingPage />, errorElement },
  { path: '/pricing', element: withSuspense(<PricingPage />), errorElement },
  { path: '/auth', element: <AuthPage />, errorElement },
  { path: '/app', element: <ProtectedRoute>{withSuspense(<HomePage />)}</ProtectedRoute>, errorElement },
  { path: '/profile', element: <ProtectedRoute>{withSuspense(<ProfilePage />)}</ProtectedRoute>, errorElement },
  { path: '/sessions/:code/:playerSlug', element: withSuspense(<DevPlayerBootstrapPage />), errorElement },
  { path: '/sessions/:code', element: <ProtectedRoute>{withSuspense(<LobbyPage />)}</ProtectedRoute>, errorElement },
  { path: '/sessions/:code/stories', element: <ProtectedRoute>{withSuspense(<StorySelectionPage />)}</ProtectedRoute>, errorElement },
  { path: '/game/:sessionId', element: <ProtectedRoute>{withSuspense(<GamePage />)}</ProtectedRoute>, errorElement },
  {
    path: '/admin',
    element: <AdminRoute>{withSuspense(<AdminPage />)}</AdminRoute>,
    errorElement,
    children: [
      { index: true, element: withSuspense(<AdminOverviewPage />) },
      { path: 'triggers', element: withSuspense(<TriggersListPage />) },
      { path: 'triggers/new', element: withSuspense(<TriggerCreatePage />) },
      { path: 'triggers/:id', element: withSuspense(<TriggerDetailPage />) },
    ],
  },
  ...devRoutes,
  { path: '*', element: <Navigate to="/" replace /> },
]);

setAppRouter(router);

function AppBootstrap() {
  const initialize = useAuthStore((s) => s.initialize);
  const isInitializing = useAuthStore((s) => s.isInitializing);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      prepareAuthStorageFromLocation(window.location.pathname, window.location.search);
    }
    initialize().catch((error) => {
      logger.error('app.bootstrap_failed', 'App bootstrap initialization failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }, [initialize]);

  if (isInitializing) {
    return (
      <div className="app-bootstrap">
        <Loader size={56} />
      </div>
    );
  }

  return (
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
  );
}

function App() {
  return <AppBootstrap />;
}

export default App;
