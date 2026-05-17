import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

// Shared UI components
import Button, { LinkButton } from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import Checkbox from '../components/ui/Checkbox';
import Toggle from '../components/ui/Toggle';
import Slider from '../components/ui/Slider';
import Stepper from '../components/ui/Stepper';
import Loader from '../components/ui/Loader';
import MatrixBackground from '../components/ui/MatrixBackground';
import Timer from '../components/ui/Timer';
import Alert from '../components/ui/Alert';
import Badge from '../components/ui/Badge';
import ProgressBar from '../components/ui/ProgressBar';
import Avatar from '../components/ui/Avatar';
import AmbientBackground from '../components/ui/AmbientBackground';
import IconButton from '../components/ui/IconButton';
import WaitingBlock from '../components/ui/WaitingBlock';
import SelectableCard from '../components/ui/SelectableCard';
import PageHeader from '../components/ui/PageHeader';

// Session / game composite
import CodeCard from '../components/session/CodeCard';
import SessionSettingsForm from '../components/session/SessionSettingsForm';
import GameScreenHeader from '../components/game/GameScreenHeader';
import NightWaitingScreen from '../components/game/NightWaitingScreen';
import RulesModal, { RulesButton } from '../components/game/RulesModal';
import DevPlayerQuickPill from '../components/dev/DevPlayerQuickPill';

// Profile
import SubscriptionPlanCard from '../components/profile/SubscriptionPlanCard';
import PasswordChangeForm from '../components/profile/PasswordChangeForm';

// Showcase infrastructure
import ShowcaseLayout, { SidebarSection } from '../components/showcase/ShowcaseLayout';
import ShowcaseSection from '../components/showcase/ShowcaseSection';
import ShowcaseItem from '../components/showcase/ShowcaseItem';
import { useReplayKey } from '../components/showcase/useReplayKey';
import { getAllNames } from '../components/audio/AudioTriggerPreview';
import NarratorPreview from '../components/audio/NarratorPreview';
import CharacterNameSelect from '../components/audio/CharacterNameSelect';
import AudioControls from '../components/audio/AudioControls';

import { createDefaultSessionSettings } from '../utils/sessionDefaults';
import { SessionSettings, RoleConfig } from '../types/game';
import './UiPage.scss';

// ───────────────────────── Local demo helpers ─────────────────────────

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2.1-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2.1 1.6a7 7 0 0 0 0 2.4L3 14.8l2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2.1-1.6a7 7 0 0 0 .1-1.2z" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

// Typewriter demo — local state copy of NarratorScreen animation (no gameStore).
const DEMO_TEXT = 'Город засыпает. Просыпается мафия...';

function TypewriterDemo({ replayKey }: { replayKey: number }) {
  const [displayed, setDisplayed] = useState(0);

  useEffect(() => {
    setDisplayed(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setDisplayed(i);
      if (i >= DEMO_TEXT.length) clearInterval(id);
    }, 45);
    return () => clearInterval(id);
  }, [replayKey]);

  const progress = (displayed / DEMO_TEXT.length) * 100;

  return (
    <div className="ui-demo-typewriter">
      <ProgressBar value={progress} variant="narrator" />
      <p className="ui-demo-typewriter__text">
        {DEMO_TEXT.split('').map((char, i) => (
          <span
            key={`${replayKey}-${i}`}
            className={`narrator-char ${i < displayed ? 'narrator-char--visible' : ''}`}
          >
            {char}
          </span>
        ))}
      </p>
    </div>
  );
}

// Stagger list — copies lobby-player-item layout with animation-delay.
const MOCK_PLAYERS = [
  { id: '1', name: 'Алиса', is_host: true },
  { id: '2', name: 'Борис', is_host: false },
  { id: '3', name: 'Варя', is_host: false },
  { id: '4', name: 'Глеб', is_host: false },
  { id: '5', name: 'Даша', is_host: false },
];

function StaggerListDemo({ replayKey }: { replayKey: number }) {
  return (
    <div className="ui-demo-stagger" key={replayKey}>
      {MOCK_PLAYERS.map((player, index) => (
        <div
          key={player.id}
          className={`lobby-player-item ${player.is_host ? '' : ''}`}
          style={{ animationDelay: `${index * 0.08}s` }}
        >
          <div className="lobby-player-item__avatar">
            <span>{player.name.charAt(0)}</span>
          </div>
          <div className="lobby-player-item__info">
            <span className="lobby-player-item__name">
              {player.name}
              {player.is_host && <span className="lobby-player-item__badge">Хост</span>}
            </span>
            <span className="lobby-player-item__order">Игрок #{index + 1}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Role card flip demo — locally replicates role-card animation.
function RoleCardFlipDemo({ replayKey }: { replayKey: number }) {
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    setFlipped(false);
    const t = setTimeout(() => setFlipped(true), 400);
    return () => clearTimeout(t);
  }, [replayKey]);

  return (
    <div className="ui-demo-role-card">
      <div
        className={`role-card ${flipped ? 'role-card--flipped' : ''}`}
        onClick={() => setFlipped((v) => !v)}
      >
        <div className="role-card__inner">
          <div className="role-card__back">
            <img src="/img/Obratnaya_storona_karty.png" alt="Back" className="role-card__back-img" />
          </div>
          <div className="role-card__front">
            <img src="/img/mafia.png" alt="Front" className="role-card__front-img" />
          </div>
        </div>
      </div>
    </div>
  );
}

// Countdown demo — local 15s timer, reset by replayKey.
function CountdownTimerDemo({
  replayKey,
  startSeconds = 15,
}: {
  replayKey: number;
  startSeconds?: number;
}) {
  const [seconds, setSeconds] = useState(startSeconds);

  useEffect(() => {
    setSeconds(startSeconds);
    const id = setInterval(() => {
      setSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [replayKey, startSeconds]);

  return <Timer seconds={seconds} dangerThreshold={5} />;
}

// Check result badge — mount animation replays on key bump.
function CheckResultBadgeDemo({
  replayKey,
  variant,
}: {
  replayKey: number;
  variant: 'mafia' | 'city';
}) {
  return (
    <div
      key={replayKey}
      className={`night-action__result-badge ${
        variant === 'mafia' ? 'night-action__result-badge--mafia' : 'night-action__result-badge--city'
      }`}
    >
      {variant === 'mafia' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 9v2m0 4h.01" />
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </div>
  );
}

// Modal demo with local open state.
function ModalOpenDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-demo-modal">
      <Button onClick={() => setOpen(true)}>Открыть модалку</Button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Пример модалки">
        <p style={{ color: '#fff', margin: 0 }}>
          Содержимое модалки. Scale-in на десктопе, slide-up на мобилке.
        </p>
      </Modal>
    </div>
  );
}

// Rules modal demo.
function RulesModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-demo-rules">
      <RulesButton onClick={() => setOpen(true)} />
      <RulesModal isOpen={open} onClose={() => setOpen(false)} />
    </div>
  );
}

// Pause button shadow demo — same visual as PauseButton but with local state.
function PauseButtonDemo() {
  const [paused, setPaused] = useState(false);
  const classes = ['pause-btn', paused ? 'pause-btn--paused' : ''].filter(Boolean).join(' ');
  return (
    <button className={classes} onClick={() => setPaused((v) => !v)} title={paused ? 'Продолжить' : 'Пауза'}>
      {paused ? (
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
      )}
    </button>
  );
}

// Game screen header demo.
function GameScreenHeaderDemo({ replayKey }: { replayKey: number }) {
  return (
    <div className="ui-demo-game-header">
      <GameScreenHeader
        title="Ход Шерифа"
        pauseSlot={<PauseButtonDemo />}
        right={<RulesButton onClick={() => {}} />}
        timer={<CountdownTimerDemo replayKey={replayKey} startSeconds={15} />}
      />
    </div>
  );
}

// Session settings form demo with local state.
function CharacterNameSelectDemo() {
  const [v, setV] = React.useState('');
  return (
    <CharacterNameSelect
      value={v}
      onChange={setV}
      occupiedNames={['Артём', 'Марина']}
    />
  );
}

function NamesGallery() {
  const names = getAllNames();
  if (!names.length) {
    return <div style={{ padding: 16, color: 'rgba(255,255,255,0.5)' }}>Манифест пуст</div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, padding: 12 }}>
      {names.map((n) => (
        <NameRow key={n.display} name={n} />
      ))}
    </div>
  );
}

function NameRow({ name }: { name: { display: string; gender: 'm' | 'f'; intro_audio: string; intro_duration_ms: number } }) {
  const [playing, setPlaying] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const toggle = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio(name.intro_audio);
      audioRef.current.addEventListener('ended', () => setPlaying(false));
    }
    if (playing) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  };
  React.useEffect(() => () => {
    if (audioRef.current) audioRef.current.pause();
  }, []);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: 'rgba(0,0,0,0.25)', borderRadius: 6 }}>
      <button
        onClick={toggle}
        style={{
          width: 28, height: 28, borderRadius: '50%',
          border: '1px solid rgba(200,30,30,0.4)', background: playing ? 'rgba(200,30,30,0.6)' : 'rgba(200,30,30,0.1)',
          color: '#fff', cursor: 'pointer', fontSize: 11,
        }}
      >
        {playing ? '■' : '▶'}
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, color: '#fff' }}>{name.display}</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
          {name.gender === 'f' ? 'жен' : 'муж'} · {(name.intro_duration_ms / 1000).toFixed(1)}с
        </span>
      </div>
    </div>
  );
}

function SessionSettingsFormDemo() {
  const [settings, setSettings] = useState<SessionSettings>(() => createDefaultSessionSettings());
  const [playerCount, setPlayerCount] = useState(8);

  return (
    <div className="ui-demo-settings">
      <SessionSettingsForm
        settings={settings}
        playerCount={playerCount}
        onChangePlayerCount={setPlayerCount}
        showPlayerCountSlider
        onChangeTimers={(partial) => setSettings((s) => ({ ...s, ...partial }))}
        onChangeRoleConfig={(key: keyof RoleConfig, value: number) =>
          setSettings((s) => ({ ...s, role_config: { ...s.role_config, [key]: value } }))
        }
      />
    </div>
  );
}

// ───────────────────────── Sidebar map ─────────────────────────

const SIDEBAR_SECTIONS: SidebarSection[] = [
  { id: 'primitives', title: 'Primitives' },
  { id: 'inputs', title: 'Inputs' },
  { id: 'feedback', title: 'Feedback' },
  { id: 'layout', title: 'Layout' },
  { id: 'game', title: 'Game' },
  { id: 'animations', title: 'Animations' },
  { id: 'backgrounds', title: 'Backgrounds' },
  { id: 'composite', title: 'Composite' },
  { id: 'profile', title: 'Profile' },
  { id: 'audio', title: 'Audio' },
];

// Триггеры озвучки сгруппированы по фазам сценария.
const AUDIO_TRIGGER_GROUPS: Array<{
  group: string;
  description?: string;
  triggers: Array<{ trigger: string; label: string; desc?: string }>;
}> = [
  {
    group: 'Старт игры',
    description: 'Зачитывается ведущим перед первой ночью.',
    triggers: [
      { trigger: 'rules', label: 'Озвучка правил' },
      { trigger: 'all_acknowledged', label: 'Все ознакомились с ролями' },
      { trigger: 'intro_personality', label: 'Вступление: личность' },
      { trigger: 'intro_poem', label: 'Вступление: стих' },
    ],
  },
  {
    group: 'Ночь — мафия',
    description: 'Стихи выхода, открытие/закрытие глаз, выбор жертвы.',
    triggers: [
      { trigger: 'mafia_exit_poem', label: 'Стих выхода мафии' },
      { trigger: 'mafia_eyes_open', label: 'Мафия открывает глаза' },
      { trigger: 'mafia_and_don_eyes_open', label: 'Мафия + Дон открывают глаза' },
      { trigger: 'mafia_choose', label: 'Выбор мафии' },
      { trigger: 'mafia_choice_made', label: 'Мафия сделала выбор' },
      { trigger: 'mafia_eyes_close', label: 'Мафия закрывает глаза' },
      { trigger: 'mafia_eyes_close_don_chooses', label: 'Мафия закрывает, Дон выбирает' },
      { trigger: 'don_eyes_close', label: 'Дон закрывает глаза' },
    ],
  },
  {
    group: 'Ночь — шериф / маньяк / доктор',
    description: 'Очередь специальных ролей.',
    triggers: [
      { trigger: 'sheriff_wakes', label: 'Шериф просыпается' },
      { trigger: 'sheriff_chooses', label: 'Шериф делает выбор' },
      { trigger: 'sheriff_chose', label: 'Шериф сделал выбор' },
      { trigger: 'doctor_eyes_open', label: 'Доктор открывает глаза' },
      { trigger: 'doctor_eyes_close', label: 'Доктор закрывает глаза' },
    ],
  },
  {
    group: 'Утро / итоги ночи',
    description: 'Объявление жертв или спасения.',
    triggers: [
      { trigger: 'one_killed', label: 'Один погибший (склейка с именем)' },
      { trigger: 'no_one_killed_doctor', label: 'Никого не убили — доктор спас' },
      { trigger: 'after_night_result', label: 'Переход к обсуждению' },
    ],
  },
  {
    group: 'День — обсуждение и голосование',
    triggers: [
      { trigger: 'after_discussion', label: 'Конец обсуждения, начало голосования' },
      { trigger: 'after_voting', label: 'После голосования (изгнание)' },
      { trigger: 'no_accuse', label: 'Никого не обвинили' },
      { trigger: 'tie_first', label: 'Ничья — переголосование' },
      { trigger: 'tie_host_kick', label: 'Ничья — ведущий кикает' },
      { trigger: 'tie_players_chose', label: 'Ничья — игроки выбрали' },
      { trigger: 'end_day_start_night_2', label: 'Конец дня, начало 2-й ночи' },
    ],
  },
  {
    group: 'Финал',
    description: 'Объявление победителя — до и после финального голосования.',
    triggers: [
      { trigger: 'mafia_win_pre', label: 'Победа мафии (до голосования)' },
      { trigger: 'mafia_win_post', label: 'Победа мафии (после голосования)' },
      { trigger: 'city_win_pre', label: 'Победа мирных (до голосования)' },
      { trigger: 'city_win_post', label: 'Победа мирных (после голосования)' },
      { trigger: 'maniac_win_pre', label: 'Победа маньяка (без голосования)' },
      { trigger: 'maniac_win_post', label: 'Победа маньяка (после голосования)' },
    ],
  },
];

// ───────────────────────── Page ─────────────────────────

export default function UiPage() {
  // Все хуки вызываются всегда в одном порядке (rules-of-hooks).
  // Production-guard — после них. Также route не монтируется в prod-бандле
  // (см. src/App.tsx: lazy-import под `process.env.NODE_ENV !== 'production'`).
  const typewriter = useReplayKey();
  const stagger = useReplayKey();
  const flip = useReplayKey();
  const sky = useReplayKey();
  const timerDemo = useReplayKey();
  const checkMafia = useReplayKey();
  const checkCity = useReplayKey();
  const headerDemo = useReplayKey();

  if (process.env.NODE_ENV === 'production') {
    return <Navigate to="/" replace />;
  }

  const devPlayerLinks = [
    { slot_number: 1, player_slug: 'host', player_name: 'Ведущий', url: '#' },
    { slot_number: 2, player_slug: 'p2', player_name: 'Игрок 2', url: '#' },
    { slot_number: 3, player_slug: 'p3', player_name: 'Игрок 3', url: '#' },
  ];

  return (
    <div className="ui-page">
      <ShowcaseLayout sections={SIDEBAR_SECTIONS}>

        {/* ───── Primitives ───── */}
        <ShowcaseSection id="primitives" title="Primitives" description="Базовые кнопки и бейджи.">
          <ShowcaseItem
            name="Button"
            path="src/components/ui/Button.tsx"
            description="Основная кнопка с glow-эффектом и состоянием загрузки."
            states={[
              { label: 'default', node: <Button onClick={() => {}}>Click me</Button> },
              { label: 'loading', node: <Button loading>Processing</Button> },
              { label: 'disabled', node: <Button disabled>Disabled</Button> },
            ]}
          />
          <ShowcaseItem
            name="LinkButton"
            path="src/components/ui/Button.tsx"
            description="Текстовая кнопка-ссылка (переключение login/register)."
            states={[
              { label: 'default', node: <LinkButton text="Нет аккаунта?" linkText="Создать" onClick={() => {}} /> },
            ]}
          />
          <ShowcaseItem
            name="Badge"
            path="src/components/ui/Badge.tsx"
            description="Маленькая цветная плашка для статусов и меток."
            states={[
              { label: 'host', node: <Badge variant="host">Хост</Badge> },
              { label: 'mafia', node: <Badge variant="mafia">МАФИЯ</Badge> },
              { label: 'city', node: <Badge variant="city">ЧИСТ</Badge> },
              { label: 'blocked', node: <Badge variant="blocked">Заблокирован</Badge> },
              { label: 'pro (md)', node: <Badge variant="pro" size="md">PRO</Badge> },
              { label: 'default (md)', node: <Badge variant="default" size="md">Обычная</Badge> },
              { label: 'dead', node: <Badge variant="dead">Выбыл</Badge> },
            ]}
          />
        </ShowcaseSection>

        {/* ───── Inputs ───── */}
        <ShowcaseSection id="inputs" title="Inputs" description="Формы, переключатели, слайдеры.">
          <ShowcaseItem
            name="Input"
            path="src/components/ui/Input.tsx"
            description="Текстовое поле с плавающим label, поддержкой password-toggle."
            states={[
              { label: 'empty', node: <div style={{ width: 240 }}><Input label="Email" value="" onChange={() => {}} /></div> },
              { label: 'filled', node: <div style={{ width: 240 }}><Input label="Имя" value="Александр" onChange={() => {}} /></div> },
              { label: 'password', node: <div style={{ width: 240 }}><Input type="password" label="Пароль" value="secret" onChange={() => {}} /></div> },
              { label: 'error', node: <div style={{ width: 240 }}><Input label="Email" value="bad" onChange={() => {}} error="Неверный формат" /></div> },
              { label: 'disabled', node: <div style={{ width: 240 }}><Input label="Заблокировано" value="text" onChange={() => {}} disabled /></div> },
            ]}
          />
          <ShowcaseItem
            name="Checkbox"
            path="src/components/ui/Checkbox.tsx"
            description="Кастомный чекбокс."
            states={[
              { label: 'unchecked', node: <Checkbox checked={false} onChange={() => {}} /> },
              { label: 'checked', node: <Checkbox checked={true} onChange={() => {}} /> },
              { label: 'disabled', node: <Checkbox checked={true} onChange={() => {}} disabled /> },
            ]}
          />
          <ShowcaseItem
            name="Toggle"
            path="src/components/ui/Toggle.tsx"
            description="Переключатель с опциональным лейблом."
            states={[
              { label: 'off', node: <Toggle checked={false} onChange={() => {}} /> },
              { label: 'on', node: <Toggle checked={true} onChange={() => {}} /> },
              { label: 'with label', node: <Toggle checked={true} onChange={() => {}} label="С сюжетом" /> },
              { label: 'disabled', node: <Toggle checked={false} onChange={() => {}} disabled /> },
            ]}
          />
          <ShowcaseItem
            name="Slider"
            path="src/components/ui/Slider.tsx"
            description="Range-слайдер со значением и единицей измерения."
            stageClassName="ui-stage--wide"
          >
            <SliderDemo />
          </ShowcaseItem>
          <ShowcaseItem
            name="Stepper"
            path="src/components/ui/Stepper.tsx"
            description="Шаговый инкремент/декремент с границами min/max."
            stageClassName="ui-stage--wide"
          >
            <StepperDemo />
          </ShowcaseItem>
        </ShowcaseSection>

        {/* ───── Feedback ───── */}
        <ShowcaseSection id="feedback" title="Feedback" description="Индикаторы состояния и уведомления.">
          <ShowcaseItem
            name="Loader"
            path="src/components/ui/Loader.tsx"
            description="Анимированный спиннер с настраиваемым размером."
            states={[
              { label: '24', node: <Loader size={24} /> },
              { label: '40', node: <Loader size={40} /> },
              { label: '56', node: <Loader size={56} /> },
            ]}
          />
          <ShowcaseItem
            name="Timer"
            path="src/components/ui/Timer.tsx"
            description="Таймер m:ss. Danger-состояние ниже порога."
            animated
            onReplay={timerDemo.replay}
            replayLabel="Запустить таймер (15s)"
            states={[
              { label: 'normal 1:24', node: <Timer seconds={84} /> },
              { label: 'warning 0:08', node: <Timer seconds={8} dangerThreshold={10} /> },
              { label: 'danger 0:03', node: <Timer seconds={3} dangerThreshold={5} /> },
              { label: 'live countdown', node: <CountdownTimerDemo replayKey={timerDemo.key} /> },
            ]}
          />
          <ShowcaseItem
            name="ProgressBar"
            path="src/components/ui/ProgressBar.tsx"
            description="Индикатор прогресса для голосований и TTS."
            states={[
              { label: '0%', node: <div style={{ width: '100%' }}><ProgressBar value={0} variant="votes" /></div> },
              { label: '30%', node: <div style={{ width: '100%' }}><ProgressBar value={30} variant="votes" /></div> },
              { label: '75%', node: <div style={{ width: '100%' }}><ProgressBar value={75} variant="votes" /></div> },
              { label: '100%', node: <div style={{ width: '100%' }}><ProgressBar value={100} variant="votes" /></div> },
            ]}
          />
          <ShowcaseItem
            name="Alert"
            path="src/components/ui/Alert.tsx"
            description="Инлайн-уведомления. Клик по alert вызывает onDismiss если передан."
            states={[
              { label: 'error', node: <Alert variant="error">Неверный email или пароль</Alert> },
              { label: 'success', node: <Alert variant="success">Сохранено!</Alert> },
              { label: 'info', node: <Alert variant="info">Ссылка-приглашение в буфере</Alert> },
              { label: 'warning', node: <Alert variant="warning">Вы не можете голосовать</Alert> },
              { label: 'dismissible', node: <Alert variant="error" onDismiss={() => {}}>Клик, чтобы скрыть</Alert> },
              { label: 'compact', node: <Alert variant="error" compact>Коротко</Alert> },
            ]}
          />
          <ShowcaseItem
            name="WaitingBlock"
            path="src/components/ui/WaitingBlock.tsx"
            description="Loader + текст. Column/row-раскладка."
            states={[
              { label: 'column', node: <WaitingBlock text="Ожидание игроков..." /> },
              { label: 'row', node: <WaitingBlock text="Ожидание..." layout="row" loaderSize={24} /> },
              { label: 'loader only', node: <WaitingBlock loaderSize={32} /> },
            ]}
          />
        </ShowcaseSection>

        {/* ───── Layout ───── */}
        <ShowcaseSection id="layout" title="Layout" description="Шапки, модалки, контейнеры.">
          <ShowcaseItem
            name="Modal"
            path="src/components/ui/Modal.tsx"
            description="Модальное окно: scale-in на десктопе, slide-up на мобилке."
          >
            <ModalOpenDemo />
          </ShowcaseItem>
          <ShowcaseItem
            name="CodeCard"
            path="src/components/session/CodeCard.tsx"
            description="Кликабельная карточка с кодом сессии. При клике копирует в буфер."
          >
            <div style={{ width: 280 }}>
              <CodeCard code="ABC123" />
            </div>
          </ShowcaseItem>
          <ShowcaseItem
            name="PageHeader"
            path="src/components/ui/PageHeader.tsx"
            description="Универсальная шапка страницы: back + title + опциональный правый слот."
            stageClassName="ui-stage--wide"
          >
            <div style={{ width: '100%' }}>
              <PageHeader
                title="Настройки"
                onBack={() => {}}
                rightSlot={<IconButton icon={<SettingsIcon />} onClick={() => {}} ariaLabel="Settings" />}
                sticky={false}
              />
            </div>
          </ShowcaseItem>
          <ShowcaseItem
            name="IconButton"
            path="src/components/ui/IconButton.tsx"
            description="Круглая иконка-кнопка для back/settings/action-слотов."
            states={[
              { label: 'back (circle)', node: <IconButton icon={<BackIcon />} onClick={() => {}} ariaLabel="Back" /> },
              { label: 'settings (circle)', node: <IconButton icon={<SettingsIcon />} onClick={() => {}} ariaLabel="Settings" /> },
              { label: 'ghost', node: <IconButton icon={<XIcon />} onClick={() => {}} ariaLabel="Close" variant="ghost" /> },
              { label: 'disabled', node: <IconButton icon={<BackIcon />} onClick={() => {}} ariaLabel="Back" disabled /> },
            ]}
          />
          <ShowcaseItem
            name="Avatar"
            path="src/components/ui/Avatar.tsx"
            description="Аватар игрока или роли: буква, изображение или иконка."
            states={[
              { label: 'initial', node: <Avatar variant="initial" name="Александр" size={48} /> },
              { label: 'initial + team', node: <Avatar variant="initial" name="Мафия" size={48} team="mafia" /> },
              { label: 'icon + badge', node: <Avatar variant="icon" icon={<UserIcon />} size={64} badge={<EditIcon />} onClick={() => {}} /> },
              { label: 'image rounded', node: <Avatar variant="image" shape="rounded" size={44} src="/img/mafia.png" ariaLabel="Мафия" team="mafia" /> },
              { label: 'image dead', node: <Avatar variant="image" shape="rounded" size={44} src="/img/mafia.png" ariaLabel="Выбыл" team="mafia" overlay={<XIcon />} /> },
            ]}
          />
        </ShowcaseSection>

        {/* ───── Game ───── */}
        <ShowcaseSection id="game" title="Game" description="Компоненты игровых экранов.">
          <ShowcaseItem
            name="GameScreenHeader"
            path="src/components/game/GameScreenHeader.tsx"
            description="Шапка игрового экрана: pause + title + timer/rules."
            animated
            onReplay={headerDemo.replay}
            replayLabel="Перезапустить таймер"
            stageClassName="ui-stage--wide"
          >
            <GameScreenHeaderDemo replayKey={headerDemo.key} />
          </ShowcaseItem>
          <ShowcaseItem
            name="SelectableCard"
            path="src/components/ui/SelectableCard.tsx"
            description="Выбор цели в ночных/дневных действиях. State-машина."
            stageClassName="ui-stage--wide"
            states={[
              { label: 'default', node: <SelectableCard>Игрок 1</SelectableCard> },
              { label: 'selected', node: <SelectableCard state="selected" rightSlot={<CheckIcon />}>Игрок 2</SelectableCard> },
              { label: 'checked-mafia', node: <SelectableCard state="checked-mafia" rightSlot={<Badge variant="mafia">МАФИЯ</Badge>}>Игрок 3</SelectableCard> },
              { label: 'checked-city', node: <SelectableCard state="checked-city" rightSlot={<Badge variant="city">ЧИСТ</Badge>}>Игрок 4</SelectableCard> },
              { label: 'disabled', node: <SelectableCard disabled>Игрок 5</SelectableCard> },
            ]}
          />
          <ShowcaseItem
            name="PauseButton"
            path="src/components/game/PauseButton.tsx"
            description="Кнопка паузы таймера. В showcase — shadow-copy с локальным state."
          >
            <PauseButtonDemo />
          </ShowcaseItem>
          <ShowcaseItem
            name="RulesModal"
            path="src/components/game/RulesModal.tsx"
            description="Модалка с правилами игры (3 таба)."
          >
            <RulesModalDemo />
          </ShowcaseItem>
          <ShowcaseItem
            name="DevPlayerQuickPill"
            path="src/components/dev/DevPlayerQuickPill.tsx"
            description="Быстрые ссылки на тестовых игроков (только dev-лобби)."
            stageClassName="ui-stage--wide"
          >
            <DevPlayerQuickPill playerLinks={devPlayerLinks} onOpenPlayer={() => {}} onAddPlayer={() => {}} />
          </ShowcaseItem>
          <ShowcaseItem
            name="CheckResultBadge (mafia)"
            path="src/components/game/NightActionScreen.tsx"
            description="Анимированный бейдж результата проверки шерифа — mafia."
            animated
            onReplay={checkMafia.replay}
            replayLabel="Проиграть mount-анимацию"
          >
            <CheckResultBadgeDemo replayKey={checkMafia.key} variant="mafia" />
          </ShowcaseItem>
          <ShowcaseItem
            name="CheckResultBadge (city)"
            path="src/components/game/NightActionScreen.tsx"
            description="Анимированный бейдж результата проверки шерифа — city."
            animated
            onReplay={checkCity.replay}
            replayLabel="Проиграть mount-анимацию"
          >
            <CheckResultBadgeDemo replayKey={checkCity.key} variant="city" />
          </ShowcaseItem>
        </ShowcaseSection>

        {/* ───── Animations ───── */}
        <ShowcaseSection id="animations" title="Animations" description="Живые демо с кнопкой replay.">
          <ShowcaseItem
            name="Typewriter (narrator)"
            path="src/components/game/NarratorScreen.tsx"
            description="Посимвольная typewriter-анимация озвучки. В showcase — локальный shadow-copy (без gameStore)."
            animated
            onReplay={typewriter.replay}
            replayLabel="Начать заново"
          >
            <TypewriterDemo replayKey={typewriter.key} />
          </ShowcaseItem>
          <ShowcaseItem
            name="Stagger list (lobby)"
            path="src/pages/LobbyPage.tsx"
            description="Появление игроков с каскадным animation-delay."
            animated
            onReplay={stagger.replay}
            replayLabel="Добавить заново"
            stageClassName="ui-stage--wide"
          >
            <StaggerListDemo replayKey={stagger.key} />
          </ShowcaseItem>
          <ShowcaseItem
            name="RoleCard flip (3D)"
            path="src/pages/GamePage.tsx"
            description="Переворот карточки роли (3D CSS-анимация)."
            animated
            onReplay={flip.replay}
            replayLabel="Перевернуть заново"
          >
            <RoleCardFlipDemo replayKey={flip.key} />
          </ShowcaseItem>
          <ShowcaseItem
            name="Night sky"
            path="src/components/game/NightWaitingScreen.tsx"
            description="Анимированное звёздное небо. Метеоры, звёзды, пульсирующие точки."
            animated
            onReplay={sky.replay}
            replayLabel="Перезапустить небо"
            stageClassName="ui-stage--night"
          >
            <div className="ui-night-frame" key={sky.key}>
              <NightWaitingScreen />
            </div>
          </ShowcaseItem>
        </ShowcaseSection>

        {/* ───── Backgrounds ───── */}
        <ShowcaseSection id="backgrounds" title="Backgrounds" description="Декоративные фоны.">
          <ShowcaseItem
            name="AmbientBackground"
            path="src/components/ui/AmbientBackground.tsx"
            description="Фоновый градиент для игровых экранов. Варианты и blob-декорации."
            stageClassName="ui-stage--ambient"
            states={[
              { label: 'night + 3 blobs', node: <div className="ui-ambient-frame"><AmbientBackground variant="night" blobs={3} /></div> },
              { label: 'day', node: <div className="ui-ambient-frame"><AmbientBackground variant="day" /></div> },
              { label: 'voting', node: <div className="ui-ambient-frame"><AmbientBackground variant="voting" /></div> },
              { label: 'narrator', node: <div className="ui-ambient-frame"><AmbientBackground variant="narrator" /></div> },
              { label: 'finale-city', node: <div className="ui-ambient-frame"><AmbientBackground variant="finale-city" /></div> },
              { label: 'finale-mafia', node: <div className="ui-ambient-frame"><AmbientBackground variant="finale-mafia" /></div> },
            ]}
          />
          <ShowcaseItem
            name="MatrixBackground"
            path="src/components/ui/MatrixBackground.tsx"
            description="Матричный декоративный фон страницы авторизации."
            stageClassName="ui-stage--matrix"
          >
            <div className="ui-matrix-frame">
              <MatrixBackground />
            </div>
          </ShowcaseItem>
        </ShowcaseSection>

        {/* ───── Composite ───── */}
        <ShowcaseSection id="composite" title="Composite" description="Крупные составные формы.">
          <ShowcaseItem
            name="SessionSettingsForm"
            path="src/components/session/SessionSettingsForm.tsx"
            description="Форма настройки сессии (таймеры, роли). Используется в HomePage create-modal и LobbyPage settings-modal."
            stageClassName="ui-stage--wide"
          >
            <SessionSettingsFormDemo />
          </ShowcaseItem>
        </ShowcaseSection>

        {/* ───── Profile ───── */}
        <ShowcaseSection id="profile" title="Profile" description="Карточки подписки и формы из профиля.">
          <ShowcaseItem
            name="SubscriptionPlanCard (free)"
            path="src/components/profile/SubscriptionPlanCard.tsx"
            description="Карточка бесплатного тарифа. Отмечены активные и недоступные фичи."
            stageClassName="ui-stage--wide"
            states={[
              { label: 'active (current)', node: <SubscriptionPlanCard plan="free" active /> },
              { label: 'inactive (user is pro)', node: <SubscriptionPlanCard plan="free" active={false} /> },
            ]}
          />
          <ShowcaseItem
            name="SubscriptionPlanCard (pro)"
            path="src/components/profile/SubscriptionPlanCard.tsx"
            description="Карточка PRO-тарифа с ценой, короной и кнопкой апгрейда."
            stageClassName="ui-stage--wide"
            states={[
              { label: 'upgrade available', node: <SubscriptionPlanCard plan="pro" active={false} onUpgrade={() => {}} /> },
              { label: 'upgrade loading', node: <SubscriptionPlanCard plan="pro" active={false} onUpgrade={() => {}} upgradeLoading /> },
              { label: 'active (user is pro)', node: <SubscriptionPlanCard plan="pro" active /> },
            ]}
          />
          <ShowcaseItem
            name="PasswordChangeForm"
            path="src/components/profile/PasswordChangeForm.tsx"
            description="Форма смены пароля с валидацией (длина, совпадение). Без onSubmit работает в mock-режиме."
            stageClassName="ui-stage--wide"
          >
            <PasswordChangeForm />
          </ShowcaseItem>
          <ShowcaseItem
            name="LoginForm"
            path="src/components/auth/LoginForm.tsx"
            description="Форма входа с email + паролем. После успеха обновляет authStore."
            stageClassName="ui-stage--wide"
          >
            <LoginFormShowcase />
          </ShowcaseItem>
          <ShowcaseItem
            name="RegisterForm"
            path="src/components/auth/RegisterForm.tsx"
            description="Форма регистрации с валидацией email/никнейма/пароля."
            stageClassName="ui-stage--wide"
          >
            <RegisterFormShowcase />
          </ShowcaseItem>
        </ShowcaseSection>

        {/* ───── Audio ───── */}
        <ShowcaseSection
          id="audio"
          title="Audio"
          description="Озвучка фаз игры в стиле игрового NarratorScreen — typewriter + аудио, синхронизировано через server-time. Mute и громкость — через AudioControls. Несколько вариантов = рандом. Для name_pair — склейка opener → имя → closer."
        >
          <ShowcaseItem
            name="AudioControls (mute / volume)"
            path="src/components/audio/AudioControls.tsx"
            description="Глобальный плеер: mute / unmute и громкость. В игре закреплён в правом нижнем углу, состояние персистится в localStorage. Применяется ко всем аудио-инстансам через useNarrationAudio."
            stageClassName="ui-stage--wide"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16, alignItems: 'center' }}>
              <AudioControls variant="inline" />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                В реальной игре отображается как floating-плашка (правый нижний угол).
              </span>
            </div>
          </ShowcaseItem>

          <ShowcaseItem
            name="CharacterNameSelect"
            path="src/components/audio/CharacterNameSelect.tsx"
            description="Dropdown 15 озвученных имён. Используется в форме лобби — других имён ввести нельзя."
            stageClassName="ui-stage--wide"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
              <CharacterNameSelectDemo />
            </div>
          </ShowcaseItem>

          <ShowcaseItem
            name="Имена персонажей"
            path="frontend/public/audio/day/<имя>.mp3"
            description="Озвучка имён, вставляется в склейку при name_pair-триггерах."
            stageClassName="ui-stage--wide"
          >
            <NamesGallery />
          </ShowcaseItem>

          {AUDIO_TRIGGER_GROUPS.map((g) => (
            <ShowcaseItem
              key={g.group}
              name={g.group}
              path="audio_manifest.json"
              description={g.description ?? ''}
              stageClassName="ui-stage--wide"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 12 }}>
                {g.triggers.map((t) => (
                  <NarratorPreview
                    key={t.trigger}
                    trigger={t.trigger}
                    label={t.label}
                    description={t.desc}
                  />
                ))}
              </div>
            </ShowcaseItem>
          ))}
        </ShowcaseSection>
      </ShowcaseLayout>
    </div>
  );
}

// LoginForm / RegisterForm показываем через React.lazy, чтобы их тесты не
// тянулись в /ui в корневом бандле dev-страницы, и чтобы изоляция от authStore
// происходила только при первом рендере showcase.
const LazyLoginForm = React.lazy(() => import('../components/auth/LoginForm'));
const LazyRegisterForm = React.lazy(() => import('../components/auth/RegisterForm'));

function LoginFormShowcase() {
  return (
    <React.Suspense fallback={<Loader size={32} />}>
      <LazyLoginForm onToggle={() => {}} />
    </React.Suspense>
  );
}

function RegisterFormShowcase() {
  return (
    <React.Suspense fallback={<Loader size={32} />}>
      <LazyRegisterForm onToggle={() => {}} />
    </React.Suspense>
  );
}

// ───────────────────────── Small local controlled demos ─────────────────────────

function SliderDemo() {
  const [values, setValues] = useState({ volume: 50, players: 8, timer: 120 });
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Slider label="Громкость" value={values.volume} min={0} max={100} step={1} unit="%" onChange={(v) => setValues((s) => ({ ...s, volume: v }))} />
      <Slider label="Игроков" value={values.players} min={5} max={16} step={1} unit="чел" onChange={(v) => setValues((s) => ({ ...s, players: v }))} />
      <Slider label="Обсуждение" value={values.timer} min={30} max={300} step={10} onChange={(v) => setValues((s) => ({ ...s, timer: v }))} />
      <Slider label="Disabled" value={50} min={0} max={100} onChange={() => {}} disabled />
    </div>
  );
}

function StepperDemo() {
  const [values, setValues] = useState({ mafia: 1, don: 0, sheriff: 1 });
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Stepper label="Мафия" value={values.mafia} min={1} max={2} onChange={(v) => setValues((s) => ({ ...s, mafia: v }))} />
      <Stepper label="Дон (min-bounded)" value={values.don} min={0} max={1} onChange={(v) => setValues((s) => ({ ...s, don: v }))} />
      <Stepper label="Шериф (max-bounded)" value={values.sheriff} min={0} max={1} onChange={(v) => setValues((s) => ({ ...s, sheriff: v }))} />
      <Stepper label="Disabled" value={2} min={0} max={4} onChange={() => {}} disabled />
    </div>
  );
}
