import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import GapTape from '../components/landing/GapTape';
import { useAuthStore } from '../stores/authStore';
import './LandingPage.scss';

gsap.registerPlugin(ScrollTrigger);

interface ScenarioCard {
  title: string;
  tag: string;
  description: string;
  accent: string;
}

const SCENARIOS: ScenarioCard[] = [
  {
    title: 'Классическая мафия',
    tag: 'Канон',
    description:
      'Тот самый легендарный сюжет: уютный городок, в котором поселились гангстеры. Доверие, обвинения и блеф в чистом виде.',
    accent: '#c81e1e',
  },
  {
    title: 'Тёмные переулки 1930-х',
    tag: 'Нуар',
    description:
      'Сухой закон, виски, контрабанда и предательства. ИИ-ведущий ведёт повествование в стиле детективного нуара.',
    accent: '#8b0000',
  },
  {
    title: 'Любовный треугольник',
    tag: 'Драма',
    description:
      'Сценарий с любовницей и сложными отношениями. Каждое решение пропитано эмоциями.',
    accent: '#ff3333',
  },
  {
    title: 'Маньяк среди своих',
    tag: 'Триллер',
    description:
      'Кроме мафии в городе скрывается серийный убийца. Доверять нельзя никому — даже союзникам.',
    accent: '#ff4444',
  },
];

interface FeatureItem {
  icon: React.ReactNode;
  title: string;
  text: string;
}

const FEATURES: FeatureItem[] = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4" />
        <path d="M12 18v4" />
        <path d="M4.93 4.93l2.83 2.83" />
        <path d="M16.24 16.24l2.83 2.83" />
        <path d="M2 12h4" />
        <path d="M18 12h4" />
        <path d="M4.93 19.07l2.83-2.83" />
        <path d="M16.24 7.76l2.83-2.83" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    ),
    title: 'ИИ-ведущий',
    text:
      'Живая озвучка каждой фазы и каждого хода. Десятки реплик, голос подстраивается под сценарий и атмосферу. Никаких пауз — ведущий всегда под рукой.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4h12l4 4v12H4z" />
        <path d="M16 4v4h4" />
        <path d="M8 12h8" />
        <path d="M8 16h6" />
      </svg>
    ),
    title: 'Сюжетные кампании',
    text:
      'Не просто игра — целый сериал. Каждая сессия рассказывает историю: от мирного городка до криминальной империи.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3" />
        <circle cx="17" cy="9" r="2" />
        <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M15 20c0-2.2 1.8-4 4-4s2 1 2 1" />
      </svg>
    ),
    title: 'Глубокие роли',
    text:
      'Дон, Шериф, Доктор, Любовница, Маньяк — каждая роль со своей механикой и своими репликами. До 15 игроков в сессии.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </svg>
    ),
    title: 'Real-time синхронизация',
    text:
      'Все игроки слышат одну и ту же реплику в одну и ту же секунду. Таймеры, голосования, ночные действия — всё в реальном времени.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 9h10" />
        <path d="M7 13h6" />
      </svg>
    ),
    title: 'Полное погружение',
    text:
      'Атмосфера, тёмная цветовая схема, плавные анимации, продуманная типографика. Игра ощущается как маленький фильм.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" />
      </svg>
    ),
    title: 'Без ведущего-человека',
    text:
      'Не нужно искать опытного модератора. Запускайте игру в любое время — ИИ возьмёт на себя всю работу.',
  },
];

interface FAQItem {
  q: string;
  a: string;
}

const FAQ: FAQItem[] = [
  {
    q: 'Что такое MafiaMaster?',
    a: 'MafiaMaster — это онлайн-платформа для игры в Мафию с ИИ-ведущим. Вы создаёте лобби, приглашаете друзей, выбираете сюжет и играете без необходимости иметь живого ведущего. Все правила, фазы, озвучка и таймеры контролирует наш сервер.',
  },
  {
    q: 'Сколько человек нужно для игры?',
    a: 'Минимум 5, максимум 15. Чем больше игроков — тем больше ролей доступно: дон, шериф, доктор, любовница, маньяк и другие.',
  },
  {
    q: 'Как работает ИИ-ведущий?',
    a: 'Ведущий — это тщательно проработанная сценарная система с десятками реплик на каждое действие. Он озвучивает фазы, подсказывает ходы, объявляет результаты ночи и голосования. Все игроки слышат одну и ту же фразу в одно и то же время.',
  },
  {
    q: 'Игра действительно бесплатна?',
    a: 'Да. Базовая версия с классическими ролями и сюжетом полностью бесплатна. Pro-подписка открывает дополнительные сюжеты, расширенные роли и кастомизацию.',
  },
  {
    q: 'Можно ли играть с телефона?',
    a: 'Да. Интерфейс адаптивен и работает в любом современном браузере: Chrome, Safari, Firefox, Edge — на десктопе и мобильных устройствах.',
  },
  {
    q: 'Что делать, если связь оборвалась?',
    a: 'Игра автоматически восстанавливает состояние при переподключении. Вы попадёте обратно в свою фазу — таймеры, роли, текущие действия будут на месте.',
  },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const heroRef = useRef<HTMLDivElement>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // Scroll-spy: подсвечиваем в хедере ту секцию, чья середина пересекает центр
  // вьюпорта. rootMargin -50%/-50% сжимает роот в горизонтальную линию:
  // в любой момент интерсектится ровно одна секция.
  useEffect(() => {
    const sectionIds = ['features', 'scenarios', 'how', 'faq'];
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        });
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    sectionIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  // Закрываем мобильное меню на Escape, чтобы не ловить фокус внутри выпадашки.
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileMenuOpen]);

  const handleNavLink = (id: string) => {
    setMobileMenuOpen(false);
    scrollToId(id);
  };

  // Hero parallax + entry animation
  useEffect(() => {
    if (!heroRef.current) return;

    const ctx = gsap.context(() => {
      const tl = gsap.timeline();
      tl.from('.landing-hero__eyebrow', { y: 30, opacity: 0, duration: 0.8, ease: 'power3.out' })
        .from('.landing-hero__title-line', { y: 60, opacity: 0, duration: 1, ease: 'power3.out', stagger: 0.12 }, '-=0.4')
        .from('.landing-hero__lead', { y: 30, opacity: 0, duration: 0.8, ease: 'power3.out' }, '-=0.5')
        .from('.landing-hero__cta', { y: 20, opacity: 0, duration: 0.6, ease: 'power3.out' }, '-=0.4')
        .from('.landing-hero__stat', { y: 20, opacity: 0, duration: 0.6, ease: 'power3.out', stagger: 0.1 }, '-=0.3');

      gsap.to('.landing-hero__orb--red', {
        y: 80,
        scrollTrigger: {
          trigger: '.landing-hero',
          start: 'top top',
          end: 'bottom top',
          scrub: 1,
        },
      });
      gsap.to('.landing-hero__orb--dark', {
        y: -60,
        scrollTrigger: {
          trigger: '.landing-hero',
          start: 'top top',
          end: 'bottom top',
          scrub: 1,
        },
      });

      // Reveal cards on scroll. once: true — анимация играет один раз и
      // больше не реверсится. Защищает от ситуаций, когда ScrollTrigger.refresh()
      // (например, на resize / при показе-скрытии мобильного адресбара)
      // переустанавливал бы элементы в "from" состояние и запускал play заново.
      gsap.utils.toArray<HTMLElement>('.landing-feature').forEach((el) => {
        gsap.fromTo(
          el,
          { y: 40, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.8,
            ease: 'power3.out',
            scrollTrigger: {
              trigger: el,
              start: 'top bottom-=80',
              once: true,
            },
          },
        );
      });

      gsap.utils.toArray<HTMLElement>('.landing-scenario').forEach((el, i) => {
        gsap.fromTo(
          el,
          { y: 60, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.9,
            ease: 'power3.out',
            delay: i * 0.05,
            scrollTrigger: {
              trigger: el,
              start: 'top bottom-=100',
              once: true,
            },
          },
        );
      });

      gsap.utils.toArray<HTMLElement>('.landing-step').forEach((el) => {
        gsap.fromTo(
          el,
          { x: -40, opacity: 0 },
          {
            x: 0,
            opacity: 1,
            duration: 0.8,
            ease: 'power3.out',
            scrollTrigger: {
              trigger: el,
              start: 'top bottom-=80',
              once: true,
            },
          },
        );
      });
    }, heroRef);

    // После того как все шрифты/картинки догрузились — рефреш ScrollTrigger,
    // чтобы trigger-позиции были корректны (иначе из-за изменений layout после
    // mount триггеры могут оказаться в неправильных скролл-позициях).
    const refreshHandler = () => ScrollTrigger.refresh();
    if (document.readyState === 'complete') {
      // Уже загрузилось — рефрешим в следующем кадре, чтобы layout успел осесть.
      requestAnimationFrame(refreshHandler);
    } else {
      window.addEventListener('load', refreshHandler, { once: true });
    }

    return () => {
      window.removeEventListener('load', refreshHandler);
      ctx.revert();
    };
  }, []);

  const handlePlay = () => {
    if (isAuthenticated) {
      navigate('/app');
    } else {
      navigate('/auth');
    }
  };

  const scrollToId = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="landing" ref={heroRef}>
      {/* ─── NAVBAR (glass, fixed — следует за скроллом + scroll-spy) ─── */}
      <nav className="landing-nav landing-nav--glass">
        <div className="landing-nav__inner">
          <Link to="/" className="landing-nav__logo">
            <img src="/img/logo.png" alt="MafiaMaster" className="landing-nav__logo-img" />
            <span className="landing-nav__logo-text">MafiaMaster</span>
          </Link>
          <div className="landing-nav__links">
            <button
              className={activeSection === 'features' ? 'is-active' : ''}
              onClick={() => scrollToId('features')}
            >
              Возможности
            </button>
            <button
              className={activeSection === 'scenarios' ? 'is-active' : ''}
              onClick={() => scrollToId('scenarios')}
            >
              Сюжеты
            </button>
            <button
              className={activeSection === 'how' ? 'is-active' : ''}
              onClick={() => scrollToId('how')}
            >
              Как играть
            </button>
            <Link to="/pricing">Тарифы</Link>
            <button
              className={activeSection === 'faq' ? 'is-active' : ''}
              onClick={() => scrollToId('faq')}
            >
              FAQ
            </button>
          </div>
          <div className="landing-nav__actions">
            <button
              type="button"
              className="landing-nav__menu-btn"
              aria-label={mobileMenuOpen ? 'Закрыть меню' : 'Открыть меню'}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {mobileMenuOpen ? (
                  <>
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </>
                ) : (
                  <>
                    <line x1="4" y1="7" x2="20" y2="7" />
                    <line x1="4" y1="12" x2="20" y2="12" />
                    <line x1="4" y1="17" x2="20" y2="17" />
                  </>
                )}
              </svg>
            </button>
            <button className="landing-btn landing-btn--primary landing-btn--small" onClick={handlePlay}>
              <span>{isAuthenticated ? 'В приложение' : 'Играть'}</span>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z" />
              </svg>
            </button>
          </div>
          {mobileMenuOpen && (
            <div className="landing-nav__mobile-menu" role="menu">
              <button onClick={() => handleNavLink('features')}>Возможности</button>
              <button onClick={() => handleNavLink('scenarios')}>Сюжеты</button>
              <button onClick={() => handleNavLink('how')}>Как играть</button>
              <Link to="/pricing" onClick={() => setMobileMenuOpen(false)}>Тарифы</Link>
              <button onClick={() => handleNavLink('faq')}>FAQ</button>
            </div>
          )}
        </div>
      </nav>

      <section className="landing-hero">
        <div className="landing-hero__bg">
          <div className="landing-hero__grid" />
          <div className="landing-hero__noise" />
          <div className="landing-hero__orb landing-hero__orb--red" />
          <div className="landing-hero__orb landing-hero__orb--dark" />
        </div>
        <div className="landing-hero__inner">
          <h1 className="landing-hero__title">
            <span className="landing-hero__title-line">Город засыпает.</span>
            <span className="landing-hero__title-line landing-hero__title-line--accent">
              Просыпается мафия.
            </span>
          </h1>
          <p className="landing-hero__lead">
            Онлайн-платформа для игры в Мафию с искусственным интеллектом в роли ведущего. Сюжеты, озвучка, атмосфера — всё, чтобы вы погрузились в игру с первой секунды.
          </p>
          <div className="landing-hero__cta">
            <button className="landing-btn landing-btn--primary" onClick={handlePlay}>
              <span>Начать играть</span>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z" />
              </svg>
            </button>
            <button
              className="landing-btn landing-btn--ghost"
              onClick={() => scrollToId('features')}
            >
              Узнать больше
            </button>
          </div>
          <div className="landing-hero__stats">
            <div className="landing-hero__stat">
              <div className="landing-hero__stat-value">15</div>
              <div className="landing-hero__stat-label">игроков в сессии</div>
            </div>
            <div className="landing-hero__stat">
              <div className="landing-hero__stat-value">4+</div>
              <div className="landing-hero__stat-label">сюжетных кампании</div>
            </div>
            <div className="landing-hero__stat">
              <div className="landing-hero__stat-value">200+</div>
              <div className="landing-hero__stat-label">реплик ведущего</div>
            </div>
          </div>
        </div>
        <GapTape
          variant="landing-gap-tape--hero-cta"
          direction="right"
          speed={0.4}
          curveAmount={120}
          tilt={-4}
        />
        <div className="landing-hero__scroll-hint">
          <span />
        </div>
      </section>

      {/* ─── FEATURES ────────────────────────────────────── */}
      <section id="features" className="landing-section landing-features">
        <div className="landing-section__head landing-section__head--split landing-section__head--text-left">
          <div className="landing-section__head-copy">
            <h2 className="landing-section__kicker">Возможности</h2>
            <p className="landing-section__title">
              Не просто игра — <span className="landing-accent landing-accent--red">а спектакль</span>
            </p>
            <p className="landing-section__sub">
              Всё, что делает классическую Мафию атмосферной — собрано в одном месте и автоматизировано.
            </p>
          </div>
          <div className="landing-section__media landing-section__media--right" data-side="right">
            <img src="/img/features-mask.png" alt="" loading="lazy" />
          </div>
        </div>
        <div className="landing-features__grid">
          {FEATURES.map((f) => (
            <article key={f.title} className="landing-feature">
              <div className="landing-feature__icon">{f.icon}</div>
              <h3 className="landing-feature__title">{f.title}</h3>
              <p className="landing-feature__text">{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      <GapTape direction="right" speed={0.45} tilt={5} />

      {/* ─── AI NARRATOR SHOWCASE ────────────────────── */}
      <section className="landing-section landing-narrator">
        <div className="landing-narrator__inner">
          <div className="landing-narrator__copy">
            <h2 className="landing-section__kicker landing-section__kicker--left">ИИ-ведущий</h2>
            <p className="landing-section__title landing-section__title--left">
              Голос, ведущий вас сквозь <span className="landing-accent landing-accent--red">ночь</span>
            </p>
            <p className="landing-narrator__lead">
              Каждое действие — отдельная реплика. Каждая ночь — отдельная атмосфера. Ведущий не зачитывает шаблон — он рассказывает историю.
            </p>
            <ul className="landing-narrator__list">
              <li>
                <span className="landing-narrator__dot" />
                Десятки реплик на каждую фазу — никаких повторов
              </li>
              <li>
                <span className="landing-narrator__dot" />
                Разные стили: классика, нуар, драма, триллер
              </li>
              <li>
                <span className="landing-narrator__dot" />
                Все игроки слышат одно и то же — синхронно
              </li>
              <li>
                <span className="landing-narrator__dot" />
                Контекстные подсказки и закрывающие реплики
              </li>
            </ul>
          </div>
          <div className="landing-narrator__visual">
            <div className="landing-narrator__panel">
              <div className="landing-narrator__panel-head">
                <span className="landing-narrator__panel-dot" />
                <span>Фаза ночи · Ход мафии</span>
              </div>
              <div className="landing-narrator__quote">
                «На улице тихо, весь город уснул, но в тёмном районе — преступный разгул.
                Мафия, откройте глаза.»
              </div>
              <div className="landing-narrator__panel-foot">
                <div className="landing-narrator__wave">
                  {Array.from({ length: 18 }).map((_, i) => (
                    <span key={i} style={{ animationDelay: `${i * 0.06}s` }} />
                  ))}
                </div>
                <span className="landing-narrator__panel-time">00:30</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <GapTape direction="left" speed={0.55} tilt={-4} />

      {/* ─── SCENARIOS ───────────────────────────────────── */}
      <section id="scenarios" className="landing-section landing-scenarios">
        <div className="landing-section__head landing-section__head--split landing-section__head--text-right">
          <div className="landing-section__media landing-section__media--left" data-side="left">
            <img src="/img/scenarios-knight.png" alt="" loading="lazy" />
          </div>
          <div className="landing-section__head-copy">
            <h2 className="landing-section__kicker">Сюжеты</h2>
            <p className="landing-section__title landing-section__title--gradient">
              Каждая партия — <span>новый рассказ</span>
            </p>
            <p className="landing-section__sub">
              Выбирайте настроение перед каждой игрой. Сюжет влияет на озвучку, атмосферу и набор ролей.
            </p>
          </div>
        </div>
        <div className="landing-scenarios__grid">
          {SCENARIOS.map((s) => (
            <article
              key={s.title}
              className="landing-scenario"
              style={{ ['--accent' as any]: s.accent }}
            >
              <div className="landing-scenario__tag">{s.tag}</div>
              <h3 className="landing-scenario__title">{s.title}</h3>
              <p className="landing-scenario__text">{s.description}</p>
              <div className="landing-scenario__glow" />
            </article>
          ))}
        </div>
      </section>

      <GapTape direction="right" speed={0.4} tilt={6} />

      {/* ─── HOW IT WORKS ────────────────────────────────── */}
      <section id="how" className="landing-section landing-how">
        <div className="landing-section__head landing-section__head--split landing-section__head--text-left">
          <div className="landing-section__head-copy">
            <h2 className="landing-section__kicker">Как это работает</h2>
            <p className="landing-section__title">
              Три шага до <span className="landing-accent landing-accent--red">первой ночи</span>
            </p>
          </div>
          <div className="landing-section__media landing-section__media--right landing-section__media--compact" data-side="right">
            <img src="/img/how-map.png" alt="" loading="lazy" />
          </div>
        </div>
        <div className="landing-how__steps">
          {[
            {
              n: '01',
              title: 'Создайте лобби',
              text: 'Выберите сюжет и количество мест. Поделитесь ссылкой с друзьями — регистрация не обязательна.',
            },
            {
              n: '02',
              title: 'Соберите игроков',
              text: 'Система раздаёт роли случайно и тайно. Ведущий подстраивает стиль под выбранный сюжет.',
            },
            {
              n: '03',
              title: 'Играйте',
              text: 'ИИ озвучивает каждую фазу, следит за таймингом и подсказывает действия. Вам остаётся отыграть свою роль.',
            },
          ].map((s) => (
            <article key={s.n} className="landing-step">
              <div className="landing-step__num">{s.n}</div>
              <h3 className="landing-step__title">{s.title}</h3>
              <p className="landing-step__text">{s.text}</p>
            </article>
          ))}
        </div>
      </section>

      <GapTape direction="left" speed={0.5} tilt={-5} />

      {/* ─── PRICING TEASER ────────────────── */}
      <section className="landing-section landing-pricing-teaser">
        <div className="landing-section__head landing-section__head--split landing-section__head--text-right">
          <div className="landing-section__media landing-section__media--left" data-side="left">
            <img src="/img/pricing-side.png" alt="" loading="lazy" />
          </div>
          <div className="landing-section__head-copy">
            <h2 className="landing-section__kicker">Тарифы</h2>
            <p className="landing-section__title">
              Бесплатно навсегда. <span className="landing-accent landing-accent--gradient">Pro — для жадных до историй.</span>
            </p>
            <p className="landing-section__sub">
              Базовый функционал доступен без оплаты. Pro открывает дополнительные сюжеты, расширенные роли и кастомизацию озвучки.
            </p>
            <Link to="/pricing" className="landing-btn landing-btn--primary landing-pricing-teaser__cta">
              <span>Посмотреть тарифы</span>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* ─── FAQ ───────────────────────────────────────────── */}
      <section id="faq" className="landing-section landing-faq">
        <div className="landing-section__head">
          <h2 className="landing-section__kicker">FAQ</h2>
          <p className="landing-section__title">
            Частые <span className="landing-accent landing-accent--gradient">вопросы</span>
          </p>
        </div>
        <div className="landing-faq__list">
          {FAQ.map((item, i) => {
            const open = openFaq === i;
            return (
              <div
                key={item.q}
                className={`landing-faq__item ${open ? 'landing-faq__item--open' : ''}`}
              >
                <button
                  className="landing-faq__q"
                  onClick={() => setOpenFaq(open ? null : i)}
                >
                  <span>{item.q}</span>
                  <span className="landing-faq__plus" aria-hidden="true">
                    <span />
                    <span />
                  </span>
                </button>
                <div className="landing-faq__a-wrap">
                  <p className="landing-faq__a">{item.a}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <GapTape direction="left" speed={0.45} tilt={4} />

      {/* ─── FINAL CTA ────────────────────────────────────── */}
      <section className="landing-section landing-cta">
        <div className="landing-cta__bg" />
        <div className="landing-cta__inner">
          <h2 className="landing-cta__title">
            Город ждёт своего ведущего.
            <br />
            Им станет ИИ.
          </h2>
          <p className="landing-cta__text">
            Зарегистрируйтесь и запустите первую партию прямо сейчас.
          </p>
          <button className="landing-btn landing-btn--primary landing-btn--large" onClick={handlePlay}>
            <span>{isAuthenticated ? 'В приложение' : 'Начать бесплатно'}</span>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z" />
            </svg>
          </button>
        </div>
      </section>

      {/* ─── FOOTER ───────────────────────────────────────────── */}
      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__brand">
            <img src="/img/logo.png" alt="MafiaMaster" className="landing-footer__logo" />
            <strong>MafiaMaster</strong>
            <span className="landing-footer__tag">© {new Date().getFullYear()}</span>
          </div>
          <div className="landing-footer__links">
            <Link to="/pricing">Тарифы</Link>
            <button onClick={() => scrollToId('faq')}>FAQ</button>
            <button onClick={() => scrollToId('features')}>Возможности</button>
            <Link to="/auth">Войти</Link>
          </div>
          <div className="landing-footer__copy">
            Сделано с любовью к классической Мафии и современным технологиям.
          </div>
        </div>
      </footer>
    </div>
  );
}
