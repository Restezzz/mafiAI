import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGameStore } from '../../stores/gameStore';
import { useSessionStore } from '../../stores/sessionStore';
import { gameApi } from '../../api/gameApi';
import { sessionApi } from '../../api/sessionApi';
import { getRoleInfo, CARD_BACK_IMAGE } from '../../utils/roles';
import AmbientBackground from '../ui/AmbientBackground';
import Avatar from '../ui/Avatar';
import Alert from '../ui/Alert';
import './FinaleScreen.scss';

const DeadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

function getStatusFromError(err: unknown): number | null {
  return (err as { response?: { status?: number } })?.response?.status ?? null;
}

export default function FinaleScreen() {
  const navigate = useNavigate();
  const result = useGameStore((s) => s.result);
  const sessionId = useGameStore((s) => s.sessionId);
  const sessionCode = useGameStore((s) => s.sessionCode);
  const myPlayerName = useGameStore((s) => s.myPlayerName);
  const resetGame = useGameStore((s) => s.reset);
  const resetSession = useSessionStore((s) => s.reset);
  const fallbackCode = useSessionStore((s) => s.session?.code) ?? null;
  const code = sessionCode ?? fallbackCode;
  const [resetting, setResetting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!result) return null;

  const winner = result.winner;
  const isCityWin = winner === 'city';
  const winnerLabel =
    winner === 'city' ? 'Победа мирных!'
    : winner === 'mafia' ? 'Победа мафии!'
    : winner === 'maniac' ? 'Победа маньяка!'
    : winner
      ? `Победа: ${winner}`
      : 'Ничья';

  const handleGoHome = async () => {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    // Покидаем сессию, чтобы backend передал роль хоста или удалил пустое лобби.
    if (sessionId) {
      try {
        await sessionApi.leave(sessionId);
      } catch {
        // Игрок мог быть уже удалён сервером — игнорируем.
      }
    }
    resetGame();
    resetSession();
    navigate('/app', { replace: true });
  };

  const handleBackToLobby = async () => {
    if (!sessionId || resetting) return;
    setResetting(true);
    setError(null);
    try {
      // Сценарий A: я первый — становлюсь хостом, сбрасываю сессию.
      const resp = await gameApi.resetToLobby(sessionId);
      resetGame();
      navigate(`/sessions/${resp.data.session_code}`, { replace: true });
      return;
    } catch (err) {
      // 403 not_in_session = другой игрок уже сбросил сессию и я был удалён из players.
      // Делаем join по коду — это вернёт меня в новое лобби как обычного игрока.
      if (getStatusFromError(err) === 403 && code) {
        try {
          const name = (myPlayerName && myPlayerName.trim()) || 'Игрок';
          await sessionApi.join(code, { name });
          resetGame();
          navigate(`/sessions/${code}`, { replace: true });
          return;
        } catch (joinErr) {
          const joinMessage =
            (joinErr as { response?: { data?: { message?: string } } })?.response?.data?.message ??
            'Не удалось присоединиться к лобби. Возможно, оно уже закрыто.';
          setError(joinMessage);
          setResetting(false);
          return;
        }
      }
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Не удалось вернуться в лобби. Проверьте соединение и попробуйте снова.';
      setError(message);
      setResetting(false);
    }
  };

  return (
    <div className={`finale ${isCityWin ? 'finale--city' : 'finale--mafia'}`}>
      <AmbientBackground variant={isCityWin ? 'finale-city' : 'finale-mafia'} />

      <div className="finale__content">
        <div className="finale__trophy">
          {isCityWin ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14z" />
              <path d="M9 18h6" />
              <path d="M10 22h4" />
              <path d="M12 15v3" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14.5 2l-5 5-2-2L2 10.5 13.5 22 19 16.5l-2-2 5-5z" />
            </svg>
          )}
        </div>

        <h1 className="finale__title">{winnerLabel}</h1>
        {result.announcement?.text && (
          <p className="finale__announcement">{result.announcement.text}</p>
        )}

        <div className="finale__players">
          <h3 className="finale__players-title">Все роли</h3>
          <div className="finale__players-grid">
            {(result.players || []).map((player) => {
              const info = getRoleInfo(player.role);
              const displayName = info?.displayName ?? player.role?.name ?? '—';
              const team = info?.team ?? player.role?.team ?? 'city';
              return (
                <div
                  key={player.id}
                  className={`finale__player ${player.status === 'dead' ? 'finale__player--dead' : ''} ${team === 'mafia' ? 'finale__player--mafia' : 'finale__player--city'}`}
                >
                  <Avatar
                    variant="image"
                    shape="rounded"
                    size={44}
                    src={info?.image ?? CARD_BACK_IMAGE}
                    ariaLabel={displayName}
                    team={team === 'mafia' ? 'mafia' : 'city'}
                    overlay={player.status === 'dead' ? <DeadIcon /> : undefined}
                    className="finale__player-avatar"
                  />
                  <div className="finale__player-info">
                    <span className="finale__player-name">{player.name}</span>
                    {player.username && player.username !== player.name && (
                      <span className="finale__player-nickname">{player.username}</span>
                    )}
                    <span className={`finale__player-role ${team === 'mafia' ? 'finale__player-role--mafia' : ''}`}>
                      {displayName}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="finale__actions">
          {error && <Alert variant="error" compact>{error}</Alert>}
          <button
            className="finale__lobby-btn"
            onClick={handleBackToLobby}
            disabled={resetting || leaving}
          >
            {resetting ? 'Возврат...' : 'Вернуться в лобби'}
          </button>
          <button
            className="finale__home-btn"
            onClick={handleGoHome}
            disabled={leaving || resetting}
          >
            {leaving ? 'Выход...' : 'На главную'}
          </button>
        </div>
      </div>
    </div>
  );
}
