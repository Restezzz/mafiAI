import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useBlocker } from 'react-router-dom';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import Loader from '../components/ui/Loader';
import Alert from '../components/ui/Alert';
import WaitingBlock from '../components/ui/WaitingBlock';
import IconButton from '../components/ui/IconButton';
import PageHeader from '../components/ui/PageHeader';
import CodeCard from '../components/session/CodeCard';
import SessionSettingsForm from '../components/session/SessionSettingsForm';
import DevPlayerQuickPill from '../components/dev/DevPlayerQuickPill';
import { useSessionStore, MAX_PLAYERS, MIN_PLAYERS, getSpecialRolesCount } from '../stores/sessionStore';
import { useGameStore } from '../stores/gameStore';
import { RoleConfig } from '../types/game';
import { devApi } from '../api/devApi';
import { gameApi } from '../api/gameApi';
import { sessionApi } from '../api/sessionApi';
import { wsClient } from '../api/wsClient';
import { getApiErrorMessage } from '../utils/getApiErrorMessage';
import { logger } from '../services/logger';
import { usePageViewLogger } from '../hooks/usePageViewLogger';
import './LobbyPage.scss';

const DEV_TEST_LOBBY_MAX_PLAYERS = 20;

const SettingsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export default function LobbyPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [expandingDevLobby, setExpandingDevLobby] = useState(false);
  const [shrinkingDevLobby, setShrinkingDevLobby] = useState(false);

  const session = useSessionStore((s) => s.session);
  const players = useSessionStore((s) => s.players);
  const settings = useSessionStore((s) => s.settings);
  const isHost = useSessionStore((s) => s.isHost);
  const myPlayerId = useSessionStore((s) => s.myPlayerId);
  const setSettings = useSessionStore((s) => s.setSettings);
  const hydrateSessionDetail = useSessionStore((s) => s.hydrateSessionDetail);

  // Защита от двойного leave/close API-запроса при перехвате навигации.
  const leavingRef = useRef(false);
  // Флаг "разрешить текущую навигацию без вызова leave/close" — ставится при старте игры,
  // чтобы переход в /game/... или /sessions/:code/stories прошёл без закрытия сессии.
  const allowNavigationRef = useRef(false);

  // Всегда вызываем leave: backend сам передаст роль хоста следующему игроку или удалит
  // пустую сессию. close(session) оставлен как отдельный flow (явного закрытия хостом).
  const leaveSessionIfAny = React.useCallback(async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const state = useSessionStore.getState();
    const current = state.session;
    if (!current) {
      state.reset();
      wsClient.disconnect();
      return;
    }
    try {
      await sessionApi.leave(current.id);
    } catch {
      // Глушим: если игрока уже нет (404) или сессия уже удалена — всё равно чистим state.
    } finally {
      state.reset();
      wsClient.disconnect();
    }
  }, []);

  // Перехватываем любую SPA-навигацию из лобби (back-кнопка шапки, браузерный back, "На главную"
  // в error-view). F5/reload здесь не ловится — это специально, чтобы не выбивать игрока при
  // перезагрузке страницы (см. план).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => {
      if (allowNavigationRef.current) return false;
      if (currentLocation.pathname === nextLocation.pathname) return false;
      // Переход на страницу выбора сюжета/имени — это естественное продолжение лобби,
      // а не выход. WS-обработчик `story_phase_started` инициирует такой переход у
      // нехостов; для них allowNavigationRef ещё не выставлен.
      if (code && nextLocation.pathname === `/sessions/${code}/stories`) return false;
      return true;
    }
  );

  useEffect(() => {
    if (blocker.state === 'blocked') {
      (async () => {
        allowNavigationRef.current = true;
        await leaveSessionIfAny();
        blocker.proceed();
      })();
    }
  }, [blocker, blocker.state, leaveSessionIfAny]);

  const specialCount = getSpecialRolesCount(settings.role_config);
  usePageViewLogger('LobbyPage', { code });

  // Load session + open WebSocket on mount; tear down on unmount.
  useEffect(() => {
    if (!code) {
      navigate('/app', { replace: true });
      return;
    }

    // Сбрасываем игровое состояние от прошлой игры, чтобы реакция ниже на myRole
    // срабатывала только на новый game_started + role_assigned по WS.
    useGameStore.getState().reset();

    let cancelled = false;

    (async () => {
      try {
        await useSessionStore.getState().loadByCode(code);
        if (cancelled) return;
        const loaded = useSessionStore.getState().session;
        const myId = useSessionStore.getState().myPlayerId;
        if (loaded && !myId) {
          // Игрок не найден в сессии — вероятно, вышел из лобби в другом браузере.
          useSessionStore.getState().reset();
          navigate('/app', { replace: true });
          return;
        }
        if (loaded) {
          wsClient.connect(loaded.id);
        }
      } catch (err) {
        if (!cancelled) {
          logger.warn('api.nonfatal_failure', 'Failed to load lobby session', {
            reason: err instanceof Error ? err.message : String(err),
            code,
          });
          setLoadError(getApiErrorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // WS не рвём в cleanup: при переходе LobbyPage→GamePage соединение
      // для той же сессии переиспользуется GamePage. Отключение от сессии
      // (выход в главное меню / закрытие / кик) выполняет leaveSessionIfAny.
    };
  }, [code, navigate]);

  // Когда не-хост получает по WS свою роль (event role_assigned после game_started),
  // переходим в игру. Для хоста переход выполняет handleStartGame, поэтому здесь !isHost.
  const myRole = useGameStore((s) => s.myRole);
  useEffect(() => {
    if (!myRole || isHost || !session) return;
    allowNavigationRef.current = true;
    navigate(`/game/${session.id}`);
  }, [myRole, isHost, session, navigate]);

  const handleStartGame = async () => {
    if (!session) return;
    setStarting(true);
    try {
      // Новый флоу: хост запускает этап сюжета/выбора имён (session.status=waiting).
      // Фактический старт движка игры (gameApi.start) будет в конце фазы выбора имён.
      await sessionApi.beginStory(session.id);
      logger.info('session.begin_story_submit', 'Host submitted begin-story request', {
        sessionId: session.id,
      }, { sessionId: session.id });
      // Разрешаем blocker'у пропустить переход на страницу сюжета — сессию НЕ закрываем.
      allowNavigationRef.current = true;
      navigate(`/sessions/${code}/stories`);
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Failed to begin story phase', {
        reason: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      }, { sessionId: session.id });
      setStartError(getApiErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const handleOpenDevPlayer = (url: string, isHostSlot: boolean) => {
    if (isHostSlot) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleExpandDevLobby = async () => {
    if (!session) return;
    setExpandingDevLobby(true);
    try {
      const { data } = await devApi.expandTestLobby(session.id);
      hydrateSessionDetail(data);
    } catch (err) {
      setStartError(getApiErrorMessage(err));
    } finally {
      setExpandingDevLobby(false);
    }
  };

  const handleShrinkDevLobby = async () => {
    if (!session) return;
    setShrinkingDevLobby(true);
    try {
      const { data } = await devApi.shrinkTestLobby(session.id);
      hydrateSessionDetail(data);
    } catch (err) {
      setStartError(getApiErrorMessage(err));
    } finally {
      setShrinkingDevLobby(false);
    }
  };

  const updateRoleConfig = async (key: keyof RoleConfig, value: number) => {
    const newConfig = { ...settings.role_config, [key]: value };
    const newSpecial = getSpecialRolesCount(newConfig);
    if (newSpecial > MAX_PLAYERS) return;
    try {
      setSettingsError(null);
      await setSettings({ role_config: newConfig });
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Failed to update role config in lobby', {
        reason: err instanceof Error ? err.message : String(err),
        key,
        value,
      }, { sessionId: session?.id });
      setSettingsError(getApiErrorMessage(err));
    }
  };

  // Принимает любой подмножественный patch SessionSettings — таймеры
  // плюс Story Engine поля (use_story_engine, story_id). Имя сохранено
  // ради обратной совместимости (SessionSettingsForm prop onChangeTimers).
  const handleTimerChange = async (partial: Partial<import('../types/game').SessionSettings>) => {
    try {
      setSettingsError(null);
      await setSettings(partial);
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Failed to update lobby timers', {
        reason: err instanceof Error ? err.message : String(err),
        partial,
      }, { sessionId: session?.id });
      setSettingsError(getApiErrorMessage(err));
    }
  };

  const rolesExceedPlayers = specialCount > players.length;
  const canStart = players.length >= MIN_PLAYERS && !rolesExceedPlayers;
  const devLobby = session?.dev_lobby;
  const devPlayerLinks = devLobby?.player_links ?? [];

  if (loading) {
    return (
      <div className="lobby-page lobby-page--loading">
        <Loader size={48} />
      </div>
    );
  }

  if (loadError || !session) {
    return (
      <div className="lobby-page lobby-page--error">
        <p>{loadError || 'Сессия не найдена'}</p>
        <Button onClick={() => navigate('/app', { replace: true })}>На главную</Button>
      </div>
    );
  }

  return (
    <div className="lobby-page">
      {isHost && devLobby?.is_test_lobby && (
        <div className="lobby-dev-pill-anchor">
          <DevPlayerQuickPill
            playerLinks={devPlayerLinks}
            onOpenPlayer={handleOpenDevPlayer}
            onAddPlayer={handleExpandDevLobby}
            addDisabled={expandingDevLobby || session.player_count >= DEV_TEST_LOBBY_MAX_PLAYERS}
            onRemovePlayer={handleShrinkDevLobby}
            removeDisabled={shrinkingDevLobby || session.player_count <= 3}
          />
        </div>
      )}
      <PageHeader
        title="Лобби"
        onBack={() => navigate('/app')}
        rightSlot={
          isHost ? (
            <IconButton
              icon={<SettingsIcon />}
              onClick={() => setShowSettings(true)}
              ariaLabel="Настройки"
              size={40}
            />
          ) : undefined
        }
      />

      <main className="lobby-main">
        <CodeCard code={session.code} />

        <div className="lobby-players">
          <div className="lobby-players__header">
            <h2 className="lobby-players__title">Игроки</h2>
            <span className="lobby-players__count">
              {players.length} / {session.player_count}
            </span>
          </div>
          <div className="lobby-players__list">
            {players.map((player, index) => (
              <div
                key={player.id}
                className={`lobby-player-item ${player.id === myPlayerId ? 'lobby-player-item--me' : ''}`}
                style={{ animationDelay: `${index * 0.08}s` }}
              >
                <div className="lobby-player-item__avatar">
                  <span>{player.name.charAt(0).toUpperCase()}</span>
                </div>
                <div className="lobby-player-item__info">
                  <span className="lobby-player-item__name">
                    {player.name}
                    {player.is_host && <span className="lobby-player-item__badge">Хост</span>}
                  </span>
                  <span className="lobby-player-item__order">Игрок #{player.join_order}</span>
                </div>
              </div>
            ))}
            {players.length < session.player_count && (
              <div className="lobby-player-item lobby-player-item--empty">
                <Loader size={24} />
                <span className="lobby-player-item__waiting">Ожидание игроков...</span>
              </div>
            )}
          </div>
        </div>

        {isHost && (
          <div className="lobby-start">
            {startError && (
              <Alert variant="error" onDismiss={() => setStartError(null)}>
                {startError}
              </Alert>
            )}
            <Button onClick={handleStartGame} disabled={!canStart || starting}>
              {starting
                ? 'Запуск...'
                : rolesExceedPlayers
                  ? `Ролей (${specialCount}) больше, чем игроков (${players.length})!`
                  : canStart
                    ? 'Начать игру'
                    : `Минимум ${MIN_PLAYERS} игроков (сейчас ${players.length})`
              }
            </Button>
          </div>
        )}
        {!isHost && (
          <WaitingBlock text="Ожидание начала игры..." loaderSize={32} className="lobby-waiting-msg" />
        )}
      </main>

      <Modal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        title="Настройки сессии"
      >
        <div className="lobby-settings">
          <SessionSettingsForm
            settings={settings}
            onChangeTimers={handleTimerChange}
            onChangeRoleConfig={updateRoleConfig}
            playerCount={players.length}
            showRolesWarning
          />

          {settingsError && (
            <Alert variant="error" onDismiss={() => setSettingsError(null)}>
              {settingsError}
            </Alert>
          )}

        </div>
      </Modal>
    </div>
  );
}
