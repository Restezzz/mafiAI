import React, { useEffect, useState } from 'react';
import Slider from '../ui/Slider';
import Stepper from '../ui/Stepper';
import { SessionSettings, RoleConfig } from '../../types/game';
import {
  MIN_PLAYERS,
  MAX_PLAYERS,
  getSpecialRolesCount,
  getCiviliansCount,
} from '../../stores/sessionStore';
import { storiesApi, PublicStoryItem } from '../../api/storiesApi';
import { logger } from '../../services/logger';
import './SessionSettingsForm.scss';

interface SessionSettingsFormProps {
  settings: SessionSettings;
  onChangeTimers: (partial: Partial<SessionSettings>) => void | Promise<void>;
  onChangeRoleConfig: (key: keyof RoleConfig, value: number) => void | Promise<void>;
  playerCount: number;
  onChangePlayerCount?: (value: number) => void;
  showPlayerCountSlider?: boolean;
  showRolesWarning?: boolean;
  className?: string;
}

export default function SessionSettingsForm({
  settings,
  onChangeTimers,
  onChangeRoleConfig,
  playerCount,
  onChangePlayerCount,
  showPlayerCountSlider = false,
  showRolesWarning = false,
  className,
}: SessionSettingsFormProps) {
  const specialCount = getSpecialRolesCount(settings.role_config);
  const civiliansCount = getCiviliansCount(playerCount, settings.role_config);
  const rolesExceed = specialCount > playerCount;

  const classes = ['settings-form', className ?? ''].filter(Boolean).join(' ');

  // Подгружаем список сюжетов один раз при mount, чтобы хост мог выбрать
  // конкретный story_id из drop-down. Бэкенд (api/routers/stories.py)
  // возвращает только активные не-obsolete версии. На ошибку (например
  // миграция Story Engine не применена) — просто скрываем секцию.
  const [stories, setStories] = useState<PublicStoryItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    storiesApi
      .list()
      .then((res) => {
        if (!cancelled) setStories(res.data.stories);
      })
      .catch((err) => {
        if (!cancelled) {
          logger.warn('lobby.stories_fetch_failed', 'Failed to fetch story list', {
            reason: err instanceof Error ? err.message : String(err),
          });
          // Пустой массив — секция скрыта (см. ниже {stories && stories.length > 0}).
          setStories([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const useStoryEngine = settings.use_story_engine === true;

  return (
    <div className={classes}>
      {showPlayerCountSlider && onChangePlayerCount && (
        <section className="settings-form__section">
          <h4 className="settings-form__section-title">Игроки</h4>
          <Slider
            label="Количество игроков"
            value={playerCount}
            min={MIN_PLAYERS}
            max={MAX_PLAYERS}
            step={1}
            unit="чел"
            onChange={onChangePlayerCount}
          />
        </section>
      )}

      <section className="settings-form__section">
        <h4 className="settings-form__section-title">Таймеры</h4>
        <Slider
          label="Обсуждение"
          value={settings.discussion_timer_seconds}
          min={30}
          max={300}
          step={10}
          onChange={(v) => onChangeTimers({ discussion_timer_seconds: v })}
        />
        <Slider
          label="Голосование"
          value={settings.voting_timer_seconds}
          min={15}
          max={120}
          step={5}
          onChange={(v) => onChangeTimers({ voting_timer_seconds: v })}
        />
        <Slider
          label="Ночные действия"
          value={settings.night_action_timer_seconds}
          min={15}
          max={60}
          step={5}
          onChange={(v) => onChangeTimers({ night_action_timer_seconds: v })}
        />
        <Slider
          label="Ознакомление с ролью"
          value={settings.role_reveal_timer_seconds}
          min={10}
          max={30}
          step={1}
          onChange={(v) => onChangeTimers({ role_reveal_timer_seconds: v })}
        />
      </section>

      <section className="settings-form__section">
        <h4 className="settings-form__section-title">Роли</h4>
        <Stepper
          label="Мафия"
          value={settings.role_config.mafia}
          min={1}
          max={2}
          onChange={(v) => onChangeRoleConfig('mafia', v)}
        />
        <Stepper
          label="Дон Мафии"
          value={settings.role_config.don}
          min={0}
          max={1}
          onChange={(v) => onChangeRoleConfig('don', v)}
        />
        <Stepper
          label="Шериф"
          value={settings.role_config.sheriff}
          min={0}
          max={1}
          onChange={(v) => onChangeRoleConfig('sheriff', v)}
        />
        <Stepper
          label="Доктор"
          value={settings.role_config.doctor}
          min={0}
          max={1}
          onChange={(v) => onChangeRoleConfig('doctor', v)}
        />
        <Stepper
          label="Любовница"
          value={settings.role_config.lover}
          min={0}
          max={1}
          onChange={(v) => onChangeRoleConfig('lover', v)}
        />
        <Stepper
          label="Маньяк"
          value={settings.role_config.maniac}
          min={0}
          max={1}
          onChange={(v) => onChangeRoleConfig('maniac', v)}
        />

        <div className="settings-form__civilians">
          <span className="settings-form__civilians-label">Мирные жители</span>
          <span className="settings-form__civilians-count">{civiliansCount}</span>
        </div>
        <p className="settings-form__hint">В партии должна быть минимум 1 мафия.</p>

        {showRolesWarning && (
          <div className="settings-form__roles-summary">
            <span>Спец. ролей: {specialCount}</span>
            <span>Всего игроков: {playerCount}</span>
            {rolesExceed && (
              <span className="settings-form__roles-warning">
                Спец. ролей больше, чем игроков!
              </span>
            )}
          </div>
        )}
      </section>

      {stories && stories.length > 0 && (
        <section className="settings-form__section">
          <h4 className="settings-form__section-title">Сюжет (бета)</h4>
          <label className="settings-form__toggle">
            <input
              type="checkbox"
              checked={useStoryEngine}
              onChange={(e) => {
                const enabled = e.target.checked;
                // Конкретный сюжет теперь выбирается голосованием после
                // запуска лобби, поэтому story_id заранее не фиксируем —
                // сбрасываем его в null при переключении тоггла.
                onChangeTimers({
                  use_story_engine: enabled,
                  story_id: null,
                });
              }}
            />
            <span>Использовать новый сюжетный движок</span>
          </label>
          {useStoryEngine && (
            <>
              <p className="settings-form__story-hint">
                Сюжет выбирается голосованием игроков после запуска лобби.
              </p>
              {/*
                Pre-game overrides (этап 3). null = используется дефолт сюжета.
                Слайдеры показывают override; чтобы вернуть дефолт — кнопка
                «Сброс». Backend (StorySettings) применяет override поверх
                story.settings_default.
              */}
              <Slider
                label={`Множитель таймеров${
                  settings.timer_multiplier == null ? ' (дефолт сюжета)' : ''
                }`}
                value={settings.timer_multiplier ?? 1.0}
                min={0.5}
                max={2.0}
                step={0.05}
                unit="x"
                onChange={(v) => onChangeTimers({ timer_multiplier: v })}
              />
              <Slider
                label={`Пауза между фразами${
                  settings.inter_cue_pause_seconds == null
                    ? ' (дефолт сюжета)'
                    : ''
                }`}
                value={settings.inter_cue_pause_seconds ?? 0}
                min={0}
                max={5}
                step={0.1}
                unit="с"
                onChange={(v) => onChangeTimers({ inter_cue_pause_seconds: v })}
              />
              {(settings.timer_multiplier != null ||
                settings.inter_cue_pause_seconds != null) && (
                <button
                  type="button"
                  className="settings-form__reset-btn"
                  onClick={() =>
                    onChangeTimers({
                      timer_multiplier: null,
                      inter_cue_pause_seconds: null,
                    })
                  }
                >
                  Сбросить overrides к дефолту сюжета
                </button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
