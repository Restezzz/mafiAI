import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Alert from '../components/ui/Alert';
import Timer from '../components/ui/Timer';
import GameScreenHeader from '../components/game/GameScreenHeader';
import DevPlayerQuickPill from '../components/dev/DevPlayerQuickPill';
import { useSessionStore } from '../stores/sessionStore';
import { useGameStore } from '../stores/gameStore';
import audioManifest from '../data/audioManifest.json';
import type { CharacterNameOption } from '../components/audio/CharacterNameSelect';
import { getCharacterDescription } from '../utils/characterDescriptions';
import { logger } from '../services/logger';
import { usePageViewLogger } from '../hooks/usePageViewLogger';
import { getApiErrorMessage } from '../utils/getApiErrorMessage';
import { gameApi } from '../api/gameApi';
import { sessionApi } from '../api/sessionApi';
import { wsClient } from '../api/wsClient';
import {
  clearAudioPreloadCache,
  configureNarrationAudioPlan,
  getAudioPreloadProgress,
  preloadNarrationAudio,
  subscribeAudioPreload,
  type AudioPreloadProgress,
} from '../utils/audioPreloader';
import './StorySelectionPage.scss';

type Phase = 'story' | 'name-pick';

const CLASSIC_STORY = {
  id: 'classic',
  title: 'Классический',
  description: 'Базовый режим Мафии без дополнительного сюжета.',
};

const NAMES: CharacterNameOption[] = (audioManifest as any).names ?? [];

const STORY_DISPLAY_MS = 2500;
const NAME_PICK_DURATION_SECONDS = 60;

export default function StorySelectionPage() {
  const navigate = useNavigate();
  const { code } = useParams<{ code: string }>();
  const [phase, setPhase] = useState<Phase>('story');
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [nameTimer, setNameTimer] = useState<number>(NAME_PICK_DURATION_SECONDS);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [audioPreloadProgress, setAudioPreloadProgress] = useState<AudioPreloadProgress>(() =>
    getAudioPreloadProgress()
  );
  // Ручной повтор предзагрузки (кнопка в состоянии ошибки): сбрасывает кэш и
  // перезапускает effect ниже — без перезагрузки всей страницы.
  const [audioRetryNonce, setAudioRetryNonce] = useState(0);

  const session = useSessionStore((s) => s.session);
  const players = useSessionStore((s) => s.players);
  const myPlayerId = useSessionStore((s) => s.myPlayerId);
  const isHost = useSessionStore((s) => s.isHost);
  // Новый сюжетный движок: имя выбирается серверной фазой name_pick ПОСЛЕ
  // голосования за сюжет (из имён победившего сюжета), а не здесь из глобального
  // каталога. Поэтому при use_story_engine локальный выбор имени пропускаем —
  // эта страница работает только как комната ожидания прелоада озвучки.
  const useStoryEngine = useSessionStore((s) => s.settings?.use_story_engine ?? false);
  const audioPreloadStatus = useSessionStore((s) => s.audioPreloadStatus);
  const setAudioPreloadStatus = useSessionStore((s) => s.setAudioPreloadStatus);
  const setSelectedStory = useSessionStore((s) => s.setSelectedStory);
  const setMyName = useSessionStore((s) => s.setMyName);
  const loadByCode = useSessionStore((s) => s.loadByCode);
  const myRole = useGameStore((s) => s.myRole);

  usePageViewLogger('StorySelectionPage', { sessionId: session?.id ?? null });

  const navigatingRef = useRef(false);
  const autoStartedRef = useRef(false);

  // Если попали сюда без предварительного хэндшейка (прямой URL / релоад) — подтягиваем
  // сессию по коду, чтобы players/myPlayerId были доступны для выбора имени.
  useEffect(() => {
    if (!code) return;
    if (session) {
      // Сессия уже подгружена (из LobbyPage). Просто убеждаемся, что WS подключён.
      wsClient.connect(session.id);
      return;
    }
    loadByCode(code)
      .then(() => {
        const loaded = useSessionStore.getState().session;
        if (loaded) wsClient.connect(loaded.id);
      })
      .catch((err) => {
        logger.warn('api.nonfatal_failure', 'Failed to hydrate story page session', {
          reason: err instanceof Error ? err.message : String(err),
          code,
        });
      });
  }, [code, session, loadByCode]);

  // Нехост переходит в игру, как только гейм-стор получил мою роль по WS.
  useEffect(() => {
    if (!myRole || isHost || !session || navigatingRef.current) return;
    navigatingRef.current = true;
    navigate(`/game/${session.id}`);
  }, [myRole, isHost, session, navigate]);

  // Новый сюжетный движок: после gameApi.start запускается фаза голосования
  // за сюжет (phase_changed → screen='story_vote'). Все клиенты переходят в
  // игру, чтобы увидеть экран голосования (роли ещё не розданы, role_assigned
  // придёт только после резолва голосования).
  const gameScreen = useGameStore((s) => s.screen);
  useEffect(() => {
    if (gameScreen !== 'story_vote' || !session || navigatingRef.current) return;
    navigatingRef.current = true;
    navigate(`/game/${session.id}`);
  }, [gameScreen, session, navigate]);

  // Авто-переход из фазы показа сюжета в выбор имени.
  useEffect(() => {
    if (phase !== 'story') return;
    if (useStoryEngine) {
      // Сюжет определится голосованием — не закрепляем CLASSIC и не показываем
      // вступительную карточку, сразу переходим в комнату ожидания.
      setPhase('name-pick');
      return;
    }
    setSelectedStory(CLASSIC_STORY.id);
    const t = setTimeout(() => setPhase('name-pick'), STORY_DISPLAY_MS);
    return () => clearTimeout(t);
  }, [phase, setSelectedStory, useStoryEngine]);

  // Таймер фазы выбора имени (локальный, синхронизация не критична — все клиенты
  // вошли на страницу практически одновременно в ответ на story_phase_started).
  useEffect(() => {
    if (phase !== 'name-pick') return;
    setNameTimer(NAME_PICK_DURATION_SECONDS);
    const interval = setInterval(() => {
      setNameTimer((s) => (s <= 0 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    const unsubscribe = subscribeAudioPreload(setAudioPreloadProgress);

    sessionApi.getAudioPreloadStatus(session.id)
      .then((response) => {
        if (!cancelled) {
          setAudioPreloadStatus(response.data);
        }
      })
      .catch((err) => {
        logger.warn('api.nonfatal_failure', 'Failed to load audio preload status', {
          reason: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        }, { sessionId: session.id });
      });

    // Сначала спрашиваем у бэка набор озвучки для ЭТОЙ сессии (story-scoped для
    // story-сюжетов, глобальный манифест для legacy), настраиваем предзагрузчик
    // и только потом грузим — иначе фронт тянул бы весь каталог (~88 файлов).
    // Версию для markAudioPreloadReady берём из результата preload (= версия
    // активного плана), чтобы readiness-карта совпала с тем, что считает бэк.
    sessionApi.getAudioPreloadManifest(session.id)
      .then((response) => {
        if (cancelled) return;
        configureNarrationAudioPlan({
          urls: response.data.audio_urls,
          version: response.data.version,
          viaApi: response.data.via_api,
        });
      })
      .catch((err) => {
        // Не фатально: остаёмся на дефолтном (глобальном) плане предзагрузки.
        logger.warn('api.nonfatal_failure', 'Failed to load audio preload manifest', {
          reason: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        }, { sessionId: session.id });
      })
      .then(() => preloadNarrationAudio())
      .then(async (result) => {
        if (cancelled || !result || result.failed > 0) return;
        const response = await sessionApi.markAudioPreloadReady(session.id, {
          manifest_version: result.manifestVersion,
        });
        if (!cancelled) {
          setAudioPreloadStatus(response.data);
        }
      })
      .catch((err) => {
        logger.warn('api.nonfatal_failure', 'Audio preload failed', {
          reason: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        }, { sessionId: session.id });
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [players.length, session, setAudioPreloadStatus, audioRetryNonce]);

  const handleRetryAudio = React.useCallback(() => {
    clearAudioPreloadCache();
    setAudioRetryNonce((n) => n + 1);
  }, []);

  const audioPlayersTotal = audioPreloadStatus?.players_total ?? players.length;
  const audioReadyCount = audioPreloadStatus?.ready_count ?? 0;
  const audioReadyPlayerIds = React.useMemo(
    () => new Set(audioPreloadStatus?.ready_player_ids ?? []),
    [audioPreloadStatus],
  );
  const localAudioReady = audioPreloadProgress.done && audioPreloadProgress.failed === 0;
  const audioReadyForGame = audioPreloadStatus
    ? localAudioReady && (!audioPreloadStatus.required || audioReadyCount >= audioPlayersTotal)
    : audioPreloadProgress.total === 0;
  const audioProgressTotal = Math.max(1, audioPreloadProgress.total);
  const audioPreloadPercent = Math.min(
    100,
    Math.round(((audioPreloadProgress.loaded + audioPreloadProgress.failed) / audioProgressTotal) * 100),
  );

  // 4 чётких состояния для UI-карточки ожидания. Раньше всё было в одной
  // строке-прогрессбаре — невозможно было понять, что вообще происходит
  // ("грузим у себя" vs "уже готов, ждём остальных" vs "ошибка").
  type AudioUiState = 'loading' | 'waiting' | 'ready' | 'error';
  const audioUiState: AudioUiState =
    audioPreloadProgress.failed > 0
      ? 'error'
      : !localAudioReady
        ? 'loading'
        : audioReadyForGame
          ? 'ready'
          : 'waiting';

  const audioStatusText =
    audioUiState === 'error'
      ? `Ошибка загрузки озвучки: ${audioPreloadProgress.failed}`
      : audioUiState === 'loading'
        ? `Загрузка озвучки ${audioPreloadProgress.loaded}/${audioPreloadProgress.total}`
        : audioUiState === 'ready'
          ? `Озвучка готова ${audioReadyCount}/${audioPlayersTotal}`
          : `Ожидание игроков ${audioReadyCount}/${audioPlayersTotal}`;

  // По истечению таймера хост автоматически запускает игру. Нехосты ждут
  // game_started/role_assigned WS-события.
  useEffect(() => {
    if (phase !== 'name-pick') return;
    if (nameTimer > 0) return;
    if (!isHost) return;
    if (!audioReadyForGame) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    void handleStartGame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioReadyForGame, nameTimer, phase, isHost]);

  const me = players.find((p) => p.id === myPlayerId) ?? null;
  const myName = me?.name ?? '';
  const occupiedByOthers = new Set(
    players.filter((p) => p.id !== myPlayerId).map((p) => p.name),
  );

  const handlePickName = async (name: string) => {
    if (occupiedByOthers.has(name) || name === myName || pendingName !== null) {
      return;
    }
    setPendingName(name);
    setRenameError(null);
    try {
      await setMyName(name);
      logger.info('story.name_picked', 'Player picked name', {
        sessionId: session?.id,
        name,
      }, { sessionId: session?.id });
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Set name failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      setRenameError(getApiErrorMessage(err));
    } finally {
      setPendingName(null);
    }
  };

  const handleStartGame = async () => {
    if (!session || !isHost) return;
    if (!audioReadyForGame) return;
    setStarting(true);
    setStartError(null);
    try {
      if (!useStoryEngine) setSelectedStory(CLASSIC_STORY.id);
      await gameApi.start(session.id);
      logger.info('story.selection_completed', 'Host started game after story phase', {
        sessionId: session.id,
      }, { sessionId: session.id });
      navigatingRef.current = true;
      navigate(`/game/${session.id}`);
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Failed to start game', {
        reason: err instanceof Error ? err.message : String(err),
        sessionId: session.id,
      }, { sessionId: session.id });
      setStartError(getApiErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const devPlayerLinks = session?.dev_lobby?.player_links ?? [];
  const devSlotLabels = React.useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of players) {
      if (p.join_order != null) map[p.join_order] = p.name;
    }
    return map;
  }, [players]);
  const handleOpenDevPlayer = (url: string, isHostSlot: boolean) => {
    if (isHostSlot) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="story-page">
      {isHost && session?.dev_lobby?.is_test_lobby && devPlayerLinks.length > 0 && (
        <div className="game-dev-pill-anchor">
          <DevPlayerQuickPill
            playerLinks={devPlayerLinks}
            onOpenPlayer={handleOpenDevPlayer}
            slotLabels={devSlotLabels}
          />
        </div>
      )}
      <GameScreenHeader
        title={phase === 'story' ? 'Сюжет' : useStoryEngine ? 'Подготовка' : 'Выбор персонажа'}
        showPause={false}
        showCharacterName={false}
        pauseSlot={<span className="story-header__spacer" />}
        timer={phase === 'name-pick' && !useStoryEngine ? <Timer seconds={nameTimer} dangerThreshold={10} /> : undefined}
      />

      <main className="story-main">
        {phase === 'story' && (
          <div className="story-result">
            <Badge variant="default" size="md" className="story-result__badge">
              Сюжет
            </Badge>
            <div className="story-result__card">
              <div className="story-result__placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="12" cy="10" r="3" />
                  <path d="M6 21v-1a4 4 0 014-4h4a4 4 0 014 4v1" />
                </svg>
              </div>
              <span className="story-result__title">{CLASSIC_STORY.title}</span>
            </div>
            <p className="story-result__desc">{CLASSIC_STORY.description}</p>
          </div>
        )}

        {phase === 'name-pick' && (
          <div className="story-name-pick">
            <p className="story-name-pick__hint">
              {useStoryEngine
                ? 'После старта вы проголосуете за сюжет и выберете имя. Озвучка выбранного сюжета загрузится на этапе выбора имени.'
                : 'Выберите своё имя. Имена используются ведущим в озвучке.'}
            </p>
            {!useStoryEngine && (
              <div className="story-name-pick__current">
                <span className="story-name-pick__current-label">Вы играете как:</span>
                <span className="story-name-pick__current-name">{myName || '—'}</span>
              </div>
            )}
            {/* В story-движке озвучку грузим уже после выбора сюжета (фаза
                name_pick), поэтому в комнате ожидания карточку прелоада не
                показываем — грузить заранее нечего. */}
            {!useStoryEngine && (
            <div className={`story-audio story-audio--${audioUiState}`} role="status" aria-live="polite">
              <div className="story-audio__icon" aria-hidden="true">
                {audioUiState === 'loading' && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                )}
                {audioUiState === 'waiting' && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                )}
                {audioUiState === 'ready' && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                {audioUiState === 'error' && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                )}
              </div>
              <div className="story-audio__body">
                <div className="story-audio__title">
                  {audioUiState === 'loading' && 'Подготовка озвучки'}
                  {audioUiState === 'waiting' && 'Ждём остальных игроков'}
                  {audioUiState === 'ready' && 'Все готовы к игре'}
                  {audioUiState === 'error' && 'Не удалось загрузить озвучку'}
                </div>
                <div className="story-audio__subtitle">
                  {audioUiState === 'loading' && 'Файлы кэшируются заранее, чтобы во время игры не было пауз.'}
                  {audioUiState === 'waiting' && 'У вас всё загружено. Остальные ещё качают озвучку.'}
                  {audioUiState === 'ready' && 'Можно начинать партию.'}
                  {audioUiState === 'error' && 'Часть файлов не загрузилась. Нажмите «Повторить» — если не поможет, перезагрузите страницу.'}
                </div>
                {audioUiState === 'error' && (
                  <button
                    type="button"
                    className="admin-btn admin-btn--primary"
                    style={{ marginTop: 8 }}
                    onClick={handleRetryAudio}
                  >
                    Повторить загрузку
                  </button>
                )}
                {audioUiState === 'loading' && (
                  <>
                    <div className="story-audio__track">
                      <span style={{ width: `${audioPreloadPercent}%` }} />
                    </div>
                    <div className="story-audio__meta">
                      <span>{audioPreloadProgress.loaded}/{audioPreloadProgress.total} файлов</span>
                      <span>{audioPreloadPercent}%</span>
                    </div>
                  </>
                )}
                {audioUiState === 'waiting' && (
                  <>
                    <div className="story-audio__track">
                      <span
                        style={{
                          width: `${audioPlayersTotal > 0 ? Math.round((audioReadyCount / audioPlayersTotal) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <div className="story-audio__meta">
                      <span>Готово игроков</span>
                      <span>{audioReadyCount}/{audioPlayersTotal}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
            )}
            {!useStoryEngine && (
            <div className="story-name-pick__grid">
              {NAMES.map((n) => {
                const isMine = n.display === myName;
                const isTaken = occupiedByOthers.has(n.display);
                const isLoading = pendingName === n.display;
                const cls = [
                  'story-name-pick__name',
                  isMine && 'story-name-pick__name--mine',
                  isTaken && 'story-name-pick__name--taken',
                  isLoading && 'story-name-pick__name--loading',
                ]
                  .filter(Boolean)
                  .join(' ');
                const description = getCharacterDescription(n.display);
                return (
                  <button
                    key={n.display}
                    type="button"
                    className={cls}
                    disabled={isTaken || isLoading || isMine}
                    onClick={() => handlePickName(n.display)}
                  >
                    <div className="story-name-pick__name-head">
                      <span className="story-name-pick__name-text">{n.display}</span>
                      <span className="story-name-pick__name-gender">
                        {n.gender === 'f' ? '♀' : '♂'}
                      </span>
                    </div>
                    {description && (
                      <p className="story-name-pick__name-desc">{description}</p>
                    )}
                  </button>
                );
              })}
            </div>
            )}

            {!useStoryEngine && renameError && (
              <Alert variant="error" compact>
                {renameError}
              </Alert>
            )}

            <div className="story-name-pick__players">
              <h4 className="story-name-pick__players-title">Игроки в лобби</h4>
              <ul className="story-name-pick__players-list">
                {players.map((p) => {
                  // story-сессии не качают озвучку в комнате ожидания —
                  // индикатор готовности здесь не имеет смысла.
                  const isAudioReady = useStoryEngine || audioReadyPlayerIds.has(p.id);
                  return (
                    <li
                      key={p.id}
                      className={`story-name-pick__player${
                        p.id === myPlayerId ? ' story-name-pick__player--me' : ''
                      }`}
                    >
                      <span
                        className={`story-name-pick__player-ready story-name-pick__player-ready--${
                          isAudioReady ? 'ok' : 'wait'
                        }`}
                        title={isAudioReady ? 'Озвучка загружена' : 'Озвучка ещё загружается'}
                        aria-label={isAudioReady ? 'Озвучка загружена' : 'Озвучка загружается'}
                      >
                        {isAudioReady ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <span className="story-name-pick__player-spinner" aria-hidden="true" />
                        )}
                      </span>
                      <span className="story-name-pick__player-info">
                        <span className="story-name-pick__player-name">{p.name}</span>
                        {p.username && p.username !== p.name && (
                          <span className="story-name-pick__player-nickname">{p.username}</span>
                        )}
                      </span>
                      {p.is_host && (
                        <span className="story-name-pick__player-tag">хост</span>
                      )}
                      {p.id === myPlayerId && (
                        <span className="story-name-pick__player-tag story-name-pick__player-tag--me">вы</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            {startError && (
              <Alert variant="error" compact>
                {startError}
              </Alert>
            )}

            <div className="story-action">
              {isHost ? (
                <Button
                  onClick={handleStartGame}
                  disabled={(!useStoryEngine && !myName) || starting || !audioReadyForGame || audioPreloadProgress.failed > 0}
                  loading={starting}
                >
                  {starting
                    ? 'Запуск...'
                    : audioPreloadProgress.failed > 0
                      ? 'Ошибка загрузки озвучки'
                      : !audioReadyForGame
                        ? audioStatusText
                        : 'Начать игру'}
                </Button>
              ) : (
                <p className="story-name-pick__waiting">
                  {!audioReadyForGame
                    ? audioStatusText
                    : useStoryEngine
                    ? 'Ожидание хоста...'
                    : myName
                    ? 'Имя выбрано. Ожидание хоста...'
                    : 'Выберите своё имя'}
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
