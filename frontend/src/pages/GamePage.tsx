import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useGameStore } from '../stores/gameStore';
import { useSessionStore } from '../stores/sessionStore';
import { getApiErrorMessage } from '../utils/getApiErrorMessage';
import { wsClient } from '../api/wsClient';
import { getRoleInfo, CARD_BACK_IMAGE } from '../utils/roles';
import { API_BASE_URL } from '../utils/constants';
import NarratorScreen from '../components/game/NarratorScreen';
import NightActionScreen from '../components/game/NightActionScreen';
import NightWaitingScreen from '../components/game/NightWaitingScreen';
import DayDiscussionScreen from '../components/game/DayDiscussionScreen';
import DayVotingScreen from '../components/game/DayVotingScreen';
import FinaleScreen from '../components/game/FinaleScreen';
import StoryVoteScreen from '../components/game/StoryVoteScreen';
import NamePickScreen from '../components/game/NamePickScreen';
import GameScreenHeader from '../components/game/GameScreenHeader';
import DevPlayerQuickPill from '../components/dev/DevPlayerQuickPill';
import AudioControls from '../components/audio/AudioControls';
import Button from '../components/ui/Button';
import Loader from '../components/ui/Loader';
import Timer from '../components/ui/Timer';
import { useCountdown } from '../hooks/useCountdown';
import { logger } from '../services/logger';
import { usePageViewLogger } from '../hooks/usePageViewLogger';
import './GamePage.scss';

function NightActionIcon({ action }: { action: string }) {
  if (action === 'kill' || action === 'maniac_kill') {
    return (
      <svg className="role-abilities__action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 2l-5 5-2-2L2 10.5 13.5 22 19 16.5l-2-2 5-5z" />
      </svg>
    );
  }
  if (action === 'check' || action === 'don_check') {
    return (
      <svg className="role-abilities__action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    );
  }
  if (action === 'heal') {
    return (
      <svg className="role-abilities__action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    );
  }
  if (action === 'lover_visit') {
    return (
      <svg className="role-abilities__action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    );
  }
  return null;
}

function actionLabel(action: string): string {
  if (action === 'kill') return 'Убийство';
  if (action === 'maniac_kill') return 'Убийство (маньяк)';
  if (action === 'check') return 'Проверка';
  if (action === 'don_check') return 'Проверка шерифа';
  if (action === 'heal') return 'Лечение';
  if (action === 'lover_visit') return 'Посещение';
  return '';
}

export default function GamePage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const screen = useGameStore((s) => s.screen);
  const myRole = useGameStore((s) => s.myRole);
  const acknowledged = useGameStore((s) => s.acknowledged);
  const acknowledgedCount = useGameStore((s) => s.acknowledgedCount);
  const totalPlayers = useGameStore((s) => s.totalPlayers);
  const phase = useGameStore((s) => s.phase);
  const acknowledgeRoleAsync = useGameStore((s) => s.acknowledgeRole);

  const gamePlayers = useGameStore((s) => s.players);

  // Build slot_number → character name map for the dev pill (must be above early returns)
  const slotLabels = React.useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of gamePlayers) {
      if (p.join_order != null) map[p.join_order] = p.name;
    }
    return map;
  }, [gamePlayers]);

  const timerPaused = useSessionStore((s) => s.timerPaused);
  const roleRevealTimer = useSessionStore((s) => s.settings.role_reveal_timer_seconds);
  const session = useSessionStore((s) => s.session);
  const isHost = useSessionStore((s) => s.isHost);

  // Persist "card flipped" across F5 within the same session: once the player
  // has revealed the role, refreshing should not hide it again. Cleared once
  // we leave role_reveal phase (see effect below).
  const flipStorageKey = sessionId ? `mafia:role-revealed:${sessionId}` : null;
  const initialFlipped = (() => {
    if (!flipStorageKey) return false;
    try {
      return window.localStorage.getItem(flipStorageKey) === '1';
    } catch {
      return false;
    }
  })();

  const [flipped, setFlipped] = useState(initialFlipped);
  const [showAbilities, setShowAbilities] = useState(initialFlipped);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const autoAcknowledgeRef = useRef(false);
  usePageViewLogger('GamePage', { sessionId });
  const timeLeft = useCountdown({
    enabled: screen === 'role_reveal',
    paused: timerPaused || acknowledged,
    fallbackSeconds: roleRevealTimer,
    timerSeconds: phase?.timer_seconds,
    timerStartedAt: phase?.timer_started_at,
    resetKey: phase?.id ?? screen,
  });

  // Load game state + open WebSocket on mount.
  useEffect(() => {
    if (!sessionId) {
      navigate('/app', { replace: true });
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        await useGameStore.getState().loadState(sessionId);
        if (cancelled) return;
        // Сессия уже завершена (F5 после финала или игрок открыл ссылку на
        // закрытую сессию): у нас нет result для отрисовки финала — сразу
        // возвращаем пользователя на главную вместо тёмного экрана.
        const afterLoad = useGameStore.getState();
        if (afterLoad.screen === 'finale' && !afterLoad.result) {
          useGameStore.getState().reset();
          useSessionStore.getState().reset();
          navigate('/app', { replace: true });
          return;
        }
        // После F5 sessionStore пуст, но gameStore.loadState возвращает session_code.
        // Догружаем session detail (там dev_lobby с ссылками на тестовых игроков).
        const sessionState = useSessionStore.getState();
        if (!sessionState.session) {
          const code = afterLoad.sessionCode;
          if (code) {
            try {
              await sessionState.loadByCode(code);
            } catch (loadErr) {
              logger.warn('session.detail_hydrate_failed', 'Failed to hydrate session detail on game page', {
                reason: loadErr instanceof Error ? loadErr.message : String(loadErr),
                sessionId,
              }, { sessionId });
            }
          }
        }
        wsClient.connect(sessionId);
      } catch (err) {
        if (!cancelled) {
          logger.error('game.critical_load_failed', 'Failed to load game page state', {
            reason: err instanceof Error ? err.message : String(err),
            sessionId,
          }, { sessionId });
          setLoadError(getApiErrorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      wsClient.disconnect();
    };
  }, [navigate, sessionId]);

  // Auto-flip card if already acknowledged (e.g. after page refresh).
  useEffect(() => {
    if (screen === 'role_reveal' && acknowledged && !flipped) {
      setFlipped(true);
      setShowAbilities(true);
    }
  }, [screen, acknowledged, flipped]);

  // Чистим флаг открытой карточки в localStorage при выходе из role_reveal,
  // чтобы в следующей игре с тем же sessionId (теоретически невозможно, но всё
  // же) карточка не открывалась автоматически.
  useEffect(() => {
    if (screen && screen !== 'role_reveal' && screen !== 'syncing' && flipStorageKey) {
      try {
        window.localStorage.removeItem(flipStorageKey);
      } catch {
        // Игнорируем — это лишь cleanup.
      }
    }
  }, [screen, flipStorageKey]);

  useEffect(() => {
    if (screen !== 'role_reveal') {
      autoAcknowledgeRef.current = false;
      return;
    }

    if (timerPaused || timeLeft > 0 || acknowledged) {
      autoAcknowledgeRef.current = false;
      return;
    }

    if (autoAcknowledgeRef.current) {
      return;
    }

    autoAcknowledgeRef.current = true;
    acknowledgeRoleAsync().catch(() => {});
  }, [acknowledgeRoleAsync, acknowledged, screen, timeLeft, timerPaused]);

  const handleFlip = () => {
    if (!flipped) {
      setFlipped(true);
      if (flipStorageKey) {
        try {
          window.localStorage.setItem(flipStorageKey, '1');
        } catch {
          // localStorage может быть недоступен (private mode) — игнорируем,
          // тогда после F5 карточка снова закроется.
        }
      }
      setTimeout(() => setShowAbilities(true), 500);
    }
  };

  const handleAcknowledge = () => {
    acknowledgeRoleAsync().catch(() => {});
  };

  if (loading) {
    return (
      <div className="game-loading">
        <Loader size={48} />
      </div>
    );
  }

  if (loadError || !myRole) {
    return (
      <div className="game-error">
        <p>{loadError || 'Не удалось загрузить игру'}</p>
        <Button onClick={() => navigate('/app', { replace: true })}>На главную</Button>
      </div>
    );
  }

  const roleInfo = getRoleInfo(myRole);
  // Фича 2: пер-сюжетный визуал роли. Кастомные карточки/имя из StoryRoleOverride
  // имеют приоритет над статическим каталогом (utils/roles). card_*_url —
  // относительные пути с бэка, поэтому префиксуем API_BASE_URL.
  const overrideUrl = (url?: string | null) => (url ? `${API_BASE_URL}${url}` : null);
  const roleImage = overrideUrl(myRole.card_front_url) ?? roleInfo?.image ?? CARD_BACK_IMAGE;
  const cardBackImage = overrideUrl(myRole.card_back_url) ?? CARD_BACK_IMAGE;
  const roleDisplayName = myRole.display_name || roleInfo?.displayName || myRole.name;
  const roleDesc = myRole.description || roleInfo?.description || 'Роль без описания способностей.';
  const nightAction = myRole.abilities?.night_action;
  const devPlayerLinks = session?.dev_lobby?.player_links ?? [];

  const handleOpenDevPlayer = (url: string, isHostSlot: boolean) => {
    if (isHostSlot) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const renderGameScreen = (content: React.ReactNode) => (
    <div className="game-screen-wrapper">
      {content}
    </div>
  );

  // Render based on current screen
  const renderScreen = () => {
    switch (screen) {
      case 'syncing':
        return (
          <div className="game-loading">
            <Loader size={48} />
          </div>
        );

      case 'role_reveal':
        return (
          <div className={`role-page ${!flipped ? 'role-page--preflip' : ''}`}>
            <GameScreenHeader
              title="Ваша роль"
              timer={<Timer seconds={timeLeft} dangerThreshold={5} />}
              showRulesButton
            />

            <main className="role-main">
              <div className={`role-card ${flipped ? 'role-card--flipped' : ''}`} onClick={handleFlip}>
                <div className="role-card__inner">
                  <div className="role-card__back">
                    <img src={cardBackImage} alt="Card back" className="role-card__back-img" />
                  </div>
                  <div className="role-card__front">
                    <img src={roleImage} alt="Role" className="role-card__front-img" />
                  </div>
                </div>
              </div>
              {!flipped && (
                <p className="role-tap-hint">Нажмите на карточку, чтобы узнать роль</p>
              )}

              <div className={`role-abilities ${showAbilities ? 'role-abilities--visible' : ''}`}>
                <div className="role-abilities__card">
                  <h3 className="role-abilities__title">{roleDisplayName}</h3>
                  <p className="role-abilities__text">{roleDesc}</p>
                  {nightAction && (
                    <div className="role-abilities__action">
                      <NightActionIcon action={nightAction} />
                      <span className="role-abilities__action-text">
                        Ночное действие: {actionLabel(nightAction)}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="role-progress" aria-live="polite">
                <div className="role-progress__counter">
                  <span className="role-progress__count">{acknowledgedCount}</span>
                  <span className="role-progress__separator">/</span>
                  <span className="role-progress__total">{totalPlayers}</span>
                </div>
                <p className="role-progress__text">Ознакомились с ролями</p>
              </div>

              {flipped && !acknowledged && (
                <div className="role-acknowledge">
                  <Button onClick={handleAcknowledge}>Ознакомлен</Button>
                </div>
              )}

              {acknowledged && (
                <div className="role-waiting">
                  <p className="role-waiting__text">Ожидание остальных игроков...</p>
                  <Loader size={32} />
                </div>
              )}
            </main>
          </div>
        );

      case 'story_vote':
        return <StoryVoteScreen />;

      case 'name_pick':
        return <NamePickScreen />;

      case 'narrator':
        return renderGameScreen(<NarratorScreen />);

      case 'night_action':
        return renderGameScreen(<NightActionScreen />);

      case 'night_waiting':
        return renderGameScreen(<NightWaitingScreen />);

      case 'day_discussion':
        return renderGameScreen(<DayDiscussionScreen />);

      case 'day_voting':
        return renderGameScreen(<DayVotingScreen />);

      case 'finale':
        return (
          <div className="game-screen-wrapper">
            <FinaleScreen />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      {isHost && session?.dev_lobby?.is_test_lobby && devPlayerLinks.length > 0 && (
        <div className="game-dev-pill-anchor">
          <DevPlayerQuickPill
            playerLinks={devPlayerLinks}
            onOpenPlayer={handleOpenDevPlayer}
            slotLabels={slotLabels}
          />
        </div>
      )}
      {renderScreen()}
      <AudioControls variant="floating" />
    </>
  );
}
