import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Alert from '../components/ui/Alert';
import SessionSettingsForm from '../components/session/SessionSettingsForm';
import { useSessionStore, getSpecialRolesCount } from '../stores/sessionStore';
import { useAuthStore } from '../stores/authStore';
import { RoleConfig, SessionSettings } from '../types/game';
import { subscriptionsApi } from '../api/subscriptionsApi';
import { authApi } from '../api/authApi';
import { devApi } from '../api/devApi';
import { createDefaultSessionSettings } from '../utils/sessionDefaults';
import { getApiErrorMessage } from '../utils/getApiErrorMessage';
import { parseApiError } from '../utils/parseApiError';
import { APP_ENV } from '../utils/constants';
import { logger } from '../services/logger';
import { usePageViewLogger } from '../hooks/usePageViewLogger';
import './HomePage.scss';

export default function HomePage() {
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showProModal, setShowProModal] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const [creating, setCreating] = useState(false);
  const [creatingTestLobby, setCreatingTestLobby] = useState(false);
  const [joining, setJoining] = useState(false);
  const [createError, setCreateError] = useState('');

  const [playerCount, setPlayerCount] = useState(8);
  const [createSettings, setCreateSettings] = useState(() => createDefaultSessionSettings());

  const navigate = useNavigate();
  usePageViewLogger('HomePage');

  // Кнопка тестового лобби: в dev любому залогиненному, в проде только админам.
  // Backend гейт `require_admin_or_dev_env` дублирует это правило — фронт лишь
  // прячет UI чтобы не светить заведомо 403-абельную кнопку.
  const isAdmin = useAuthStore((s) => s.user?.is_admin === true);
  const canCreateTestLobby = APP_ENV === 'development' || isAdmin;

  const updateRoleConfig = (key: keyof RoleConfig, value: number) => {
    setCreateSettings((s) => ({
      ...s,
      role_config: { ...s.role_config, [key]: value },
    }));
  };

  const updateTimers = (partial: Partial<SessionSettings>) => {
    setCreateSettings((s) => ({ ...s, ...partial }));
  };

  const handleOpenCreate = () => {
    setCreateError('');
    setShowCreateModal(true);
  };

  const handleConfirmCreate = async () => {
    const specialCount = getSpecialRolesCount(createSettings.role_config);
    if (specialCount > playerCount) {
      setCreateError('Специальных ролей больше, чем игроков');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      // Имя не передаём — backend использует display_name как плейсхолдер.
      // Финальное имя игрок выберет на странице сюжета.
      logger.info('session.create_submit', 'Submitting session creation request', {
        playerCount,
      });
      const code = await useSessionStore.getState().createSession({
        player_count: playerCount,
        settings: createSettings,
      });
      setShowCreateModal(false);
      navigate(`/sessions/${code}`);
    } catch (err) {
      if (parseApiError(err).code === 'pro_required') {
        setShowCreateModal(false);
        setShowProModal(true);
        return;
      }
      logger.warn('api.nonfatal_failure', 'Session creation failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      setCreateError(getApiErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleCreateTestLobby = async () => {
    setCreateError('');
    setCreatingTestLobby(true);
    try {
      const { data } = await devApi.createTestLobby();
      useSessionStore.getState().hydrateSessionDetail(data);
      navigate(`/sessions/${data.code}`);
    } catch (err) {
      logger.warn('dev.test_lobby_create_failed', 'Failed to create dev test lobby', {
        reason: err instanceof Error ? err.message : String(err),
      });
      setCreateError(getApiErrorMessage(err));
    } finally {
      setCreatingTestLobby(false);
    }
  };

  const handleJoinSubmit = async () => {
    if (joinCode.trim().length < 4) {
      setJoinError('Введите корректный код сессии');
      return;
    }

    const normalizedCode = joinCode.trim().toUpperCase();
    setJoining(true);
    setJoinError('');
    try {
      // Имя не передаём — backend использует display_name как плейсхолдер.
      logger.info('session.join_submit', 'Submitting join session request', {
        code: normalizedCode,
      });
      await useSessionStore.getState().joinSession(normalizedCode);
      setShowJoinModal(false);
      setJoinCode('');
      setJoinError('');
      navigate(`/sessions/${normalizedCode}`);
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Join session failed', {
        reason: err instanceof Error ? err.message : String(err),
        code: normalizedCode,
      });
      setJoinError(getApiErrorMessage(err));
    } finally {
      setJoining(false);
    }
  };

  const handleCloseJoinModal = () => {
    setShowJoinModal(false);
    setJoinCode('');
    setJoinError('');
  };

  const handleCloseCreateModal = () => {
    setShowCreateModal(false);
    setCreateError('');
  };

  const handleUpgradeToPro = async () => {
    setUpgrading(true);
    setUpgradeError('');
    try {
      await subscriptionsApi.create({ plan: 'pro' });
      const me = await authApi.me();
      useAuthStore.getState().setUser(me.data);
      setShowProModal(false);
      // Auto-retry session creation
      await handleConfirmCreate();
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Failed to upgrade subscription to pro', {
        reason: err instanceof Error ? err.message : String(err),
      });
      setUpgradeError(getApiErrorMessage(err));
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="home-header__left">
          <button
            type="button"
            className="home-header__logo-btn"
            aria-label="На главную"
            onClick={() => navigate('/')}
          >
            <img src="/img/logo.png" alt="Logo" className="home-header__logo" />
          </button>
        </div>
        <button className="home-header__profile" aria-label="Профиль" onClick={() => navigate('/profile')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
          </svg>
        </button>
      </header>

      <main className="home-main">
        <div className="home-hero">
          <img
            src="/img/На главную.png"
            alt="MafiaMaster"
            className="home-hero__image"
          />
        </div>

        <div className="home-actions">
          <Button onClick={handleOpenCreate}>Создать сессию</Button>
          <div className="home-actions__spacer" />
          <button className="home-join-btn" onClick={() => setShowJoinModal(true)}>
            <span className="home-join-btn__glow" />
            <span className="home-join-btn__content">
              <span className="home-join-btn__text">Присоединиться к сессии</span>
            </span>
          </button>
        </div>
        {canCreateTestLobby && (
          <button
            type="button"
            className="home-test-lobby"
            aria-label="Создать тестовое лобби"
            title="Создать тестовое лобби"
            onClick={handleCreateTestLobby}
            disabled={creatingTestLobby}
          >
            {creatingTestLobby ? (
              <span className="home-test-lobby__spinner" aria-hidden />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            )}
          </button>
        )}
        {createError && <Alert variant="error" compact>{createError}</Alert>}
      </main>

      <Modal
        isOpen={showJoinModal}
        onClose={handleCloseJoinModal}
        title="Введите код"
      >
        <div className="join-modal">
          <div className="join-modal__field">
            <p className="join-modal__hint">Введите код сессии, полученный от организатора</p>
            <Input
              label="Код сессии"
              value={joinCode}
              onChange={(v) => setJoinCode(v.toUpperCase())}
              error={joinError}
            />
          </div>
          <div className="join-modal__actions">
            <Button
              onClick={handleJoinSubmit}
              disabled={joining || joinCode.trim().length === 0}
            >
              {joining ? 'Загрузка...' : 'Присоединиться'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showCreateModal}
        onClose={handleCloseCreateModal}
        title="Создать сессию"
      >
        <div className="create-modal">
          <SessionSettingsForm
            settings={createSettings}
            onChangeTimers={updateTimers}
            onChangeRoleConfig={updateRoleConfig}
            playerCount={playerCount}
            onChangePlayerCount={setPlayerCount}
            showPlayerCountSlider
          />

          {createError && <Alert variant="error">{createError}</Alert>}

          <div className="create-modal__actions">
            <Button onClick={handleConfirmCreate} disabled={creating}>
              {creating ? 'Создание...' : 'Создать'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showProModal}
        onClose={() => {
          setShowProModal(false);
          setUpgradeError('');
        }}
        title="Требуется подписка Pro"
      >
        <div className="pro-modal">
          <div className="pro-modal__benefits">
            <div className="pro-modal__benefit">
              <span className="pro-modal__benefit-icon">🆓</span>
              <span className="pro-modal__benefit-text">Бесплатно: до 12 игроков</span>
            </div>
            <div className="pro-modal__benefit pro-modal__benefit--highlight">
              <span className="pro-modal__benefit-icon">👑</span>
              <span className="pro-modal__benefit-text">Pro: до 16 игроков + новые роли (Дон, Любовница, Маньяк)</span>
            </div>
          </div>

          <div className="pro-modal__warning">
            <p>⚠️ Это dev-мокап — реальная оплата не проводится. Подписка Pro на 30 дней выдаётся бесплатно для тестирования.</p>
          </div>

          {upgradeError && <Alert variant="error">{upgradeError}</Alert>}

          <div className="pro-modal__actions">
            <Button onClick={() => setShowProModal(false)} disabled={upgrading}>
              Отмена
            </Button>
            <Button onClick={handleUpgradeToPro} loading={upgrading}>
              Оформить Pro
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
