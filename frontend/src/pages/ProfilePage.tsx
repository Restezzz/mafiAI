import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { authApi } from '../api/authApi';
import { subscriptionsApi } from '../api/subscriptionsApi';
import { SubscriptionStatusResponse } from '../types/api';
import { parseApiError } from '../utils/parseApiError';
import { getApiErrorMessage } from '../utils/getApiErrorMessage';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import Avatar from '../components/ui/Avatar';
import Badge from '../components/ui/Badge';
import PageHeader from '../components/ui/PageHeader';
import SubscriptionPlanCard from '../components/profile/SubscriptionPlanCard';
import PasswordChangeForm from '../components/profile/PasswordChangeForm';
import { logger } from '../services/logger';
import { usePageViewLogger } from '../hooks/usePageViewLogger';
import { compressAvatar } from '../utils/compressAvatar';
import './ProfilePage.scss';

const UserIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
  </svg>
);

const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

export default function ProfilePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);

  // Аватарка тянется из user.avatar_url — store обновляется при PUT /me/avatar.
  const avatarUrl = user?.avatar_url ?? null;
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState('');

  // Подписка
  const [subscription, setSubscription] = useState<SubscriptionStatusResponse | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);

  // Inline-edit nickname
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameError, setNicknameError] = useState('');
  const [nicknameSaving, setNicknameSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  usePageViewLogger('ProfilePage');

  // Загружаем статус подписки при монтировании
  useEffect(() => {
    let cancelled = false;
    setSubscriptionLoading(true);
    subscriptionsApi
      .me()
      .then(({ data }) => {
        if (!cancelled) setSubscription(data);
      })
      .catch((err) => {
        if (!cancelled) {
          // Тихо игнорируем — показываем fallback (free) из профиля
          logger.warn('api.nonfatal_failure', 'Failed to load subscription status', {
            error: parseApiError(err),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setSubscriptionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAvatarClick = () => {
    if (avatarUploading) return;
    fileInputRef.current?.click();
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Сбрасываем input, чтобы повторный выбор того же файла снова триггерил onChange.
    e.target.value = '';
    if (!file) return;

    setAvatarError('');
    setAvatarUploading(true);
    try {
      const dataUrl = await compressAvatar(file, { size: 256, quality: 0.85 });
      const { data } = await authApi.updateAvatar({ avatar_data_url: dataUrl });
      setUser(data);
      logger.info('profile.avatar_updated', 'Avatar updated', { userId: data.user_id }, { userId: data.user_id });
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Failed to update avatar', {
        reason: err instanceof Error ? err.message : String(err),
      });
      setAvatarError(getApiErrorMessage(err));
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    logger.info('auth.logout_submit', 'Profile logout completed');
    navigate('/auth', { replace: true });
  };

  const startEditNickname = () => {
    setNicknameDraft(user?.nickname ?? '');
    setNicknameError('');
    setIsEditingNickname(true);
  };

  const cancelEditNickname = () => {
    setIsEditingNickname(false);
    setNicknameError('');
  };

  const saveNickname = async () => {
    const trimmed = nicknameDraft.trim();
    if (trimmed.length < 1 || trimmed.length > 32) {
      setNicknameError('Никнейм должен быть от 1 до 32 символов');
      return;
    }
    setNicknameSaving(true);
    setNicknameError('');
    try {
      await authApi.updateNickname({ nickname: trimmed });
      const me = await authApi.me();
      setUser(me.data);
      setIsEditingNickname(false);
      logger.info('profile.nickname_updated', 'Nickname updated', {
        userId: me.data.user_id,
      }, { userId: me.data.user_id });
    } catch (err) {
      logger.warn('api.nonfatal_failure', 'Failed to update nickname', {
        reason: err instanceof Error ? err.message : String(err),
      });
      setNicknameError(getApiErrorMessage(err));
    } finally {
      setNicknameSaving(false);
    }
  };

  // Если пользователь не загружен — не рендерим приватные данные.
  if (!user) {
    return (
      <div className="profile-page">
        <PageHeader title="Профиль" onBack={() => navigate(-1)} />
        <main className="profile-main">
          <p style={{ textAlign: 'center', color: '#888' }}>Загрузка профиля...</p>
        </main>
      </div>
    );
  }

  // Определяем Pro: сначала из subscription ответа, затем из user.has_pro.
  const isPro = subscription
    ? subscription.plan === 'pro' && subscription.status === 'active'
    : user.has_pro;

  return (
    <div className="profile-page">
      <PageHeader title="Профиль" onBack={() => navigate(-1)} />

      <main className="profile-main">
        {/* Avatar Section */}
        <div className="profile-avatar-section" onClick={handleAvatarClick}>
          <Avatar
            variant={avatarUrl ? 'image' : 'icon'}
            size={100}
            src={avatarUrl ?? undefined}
            icon={<UserIcon />}
            badge={<EditIcon />}
            className="profile-avatar"
            ariaLabel="Аватар"
          />
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleAvatarChange}
            accept="image/*"
            style={{ display: 'none' }}
          />
          <p className="profile-avatar__hint">
            {avatarUploading ? 'Загрузка...' : 'Нажмите, чтобы изменить аватар'}
          </p>
          {avatarError && <p className="profile-avatar__error">{avatarError}</p>}
        </div>

        {/* Nickname Section */}
        <div className="profile-section">
          <div className="profile-section__header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
            </svg>
            <span className="profile-section__label">Никнейм</span>
          </div>
          {isEditingNickname ? (
            <div className="profile-password-form">
              <Input
                type="text"
                label="Никнейм"
                value={nicknameDraft}
                onChange={setNicknameDraft}
                error={nicknameError}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  onClick={saveNickname}
                  loading={nicknameSaving}
                  disabled={nicknameSaving}
                >
                  Сохранить
                </Button>
                <Button onClick={cancelEditNickname} disabled={nicknameSaving}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="profile-section__value"
              onClick={startEditNickname}
              style={{ cursor: 'pointer' }}
              title="Нажмите, чтобы изменить никнейм"
            >
              {user.nickname}
            </div>
          )}
        </div>

        {/* Email Section */}
        <div className="profile-section">
          <div className="profile-section__header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
            <span className="profile-section__label">Email</span>
          </div>
          <div className="profile-section__value">{user.email}</div>
        </div>

        {/* Password Change Section */}
        <div className="profile-section profile-section--password">
          <div className="profile-section__header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span className="profile-section__label">Изменить пароль</span>
          </div>
          <PasswordChangeForm />
        </div>

        {/* Subscription Section */}
        <div className="profile-subscription">
          <div className="profile-subscription__header">
            <h2 className="profile-subscription__title">Подписка</h2>
            <Badge variant={isPro ? 'pro' : 'default'} size="md">
              {subscriptionLoading ? '...' : isPro ? 'PRO' : 'Обычная'}
            </Badge>
          </div>

          <div className="profile-subscription__plans">
            <SubscriptionPlanCard plan="free" active={!isPro} />
            <SubscriptionPlanCard plan="pro" active={isPro} onUpgrade={!isPro ? () => {} : undefined} />
          </div>
        </div>

        {/* Logout */}
        <button className="profile-logout" onClick={handleLogout}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span>Выйти из аккаунта</span>
        </button>
      </main>
    </div>
  );
}
