import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import './PricingPage.scss';

interface Plan {
  id: 'free' | 'pro' | 'team';
  name: string;
  tagline: string;
  priceMonthly: number;
  priceYearly: number;
  highlighted?: boolean;
  features: string[];
  ctaLabel: string;
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Чтобы попробовать',
    priceMonthly: 0,
    priceYearly: 0,
    features: [
      'До 8 игроков в сессии',
      'Классический сюжет',
      'Базовые роли (Мафия, Шериф, Доктор)',
      'ИИ-ведущий с базовой озвучкой',
      'Real-time синхронизация',
      'Поддержка по email',
    ],
    ctaLabel: 'Начать играть',
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Для постоянной компании',
    priceMonthly: 299,
    priceYearly: 2990,
    highlighted: true,
    features: [
      'До 15 игроков в сессии',
      'Все сюжетные кампании',
      'Расширенные роли (Дон, Любовница, Маньяк)',
      'Расширенная озвучка ведущего',
      'История сессий и статистика',
      'Кастомизация таймеров',
      'Приоритетная поддержка',
    ],
    ctaLabel: 'Оформить Pro',
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'Для клубов и заведений',
    priceMonthly: 990,
    priceYearly: 9900,
    features: [
      'Всё из тарифа Pro',
      'Брендирование лобби (логотип, цвета)',
      'Множественные сессии параллельно',
      'API для интеграций',
      'Кастомные сценарии под заказ',
      'Dedicated менеджер',
    ],
    ctaLabel: 'Связаться с нами',
  },
];

const COMPARE_ROWS: Array<{ label: string; values: [string, string, string] }> = [
  { label: 'Игроков в сессии', values: ['до 8', 'до 15', 'до 15'] },
  { label: 'Сюжеты', values: ['Классика', 'Все доступные', 'Все + кастом'] },
  { label: 'Расширенные роли', values: ['—', '✓', '✓'] },
  { label: 'История сессий', values: ['7 дней', 'Без ограничений', 'Без ограничений'] },
  { label: 'Кастомизация', values: ['—', 'Базовая', 'Полная (брендинг)'] },
  { label: 'Поддержка', values: ['Email', 'Приоритетная', 'Менеджер'] },
];

export default function PricingPage() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [period, setPeriod] = useState<'monthly' | 'yearly'>('monthly');

  const handleCta = (plan: Plan) => {
    if (plan.id === 'team') {
      window.location.href = 'mailto:hello@mafiamaster.app?subject=Team%20plan';
      return;
    }
    if (isAuthenticated) {
      navigate('/app');
    } else {
      navigate('/auth');
    }
  };

  return (
    <div className="pricing-page">
      {/* ─── NAV (lite) ───────────────────────────────── */}
      <nav className="pricing-nav">
        <div className="pricing-nav__inner">
          <Link to="/" className="pricing-nav__logo">
            <span className="pricing-nav__logo-dot" />
            MafiaMaster
          </Link>
          <div className="pricing-nav__actions">
            <Link to="/" className="pricing-nav__back">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7.828 11h12.172v2H7.828l5.364 5.364-1.414 1.414L4 12l7.778-7.778 1.414 1.414L7.828 11z" />
              </svg>
              <span>На главную</span>
            </Link>
            {isAuthenticated ? (
              <button className="pricing-nav__cta" onClick={() => navigate('/app')}>
                <span>В приложение</span>
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z" />
                </svg>
              </button>
            ) : (
              <button className="pricing-nav__cta" onClick={() => navigate('/auth')}>
                <span>Играть</span>
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* ─── HEADER ──────────────────────────────────── */}
      <header className="pricing-header">
        <div className="pricing-header__bg">
          <div className="pricing-header__orb" />
        </div>
        <div className="pricing-header__inner">
          <span className="pricing-header__kicker">Тарифы</span>
          <h1 className="pricing-header__title">
            Простая цена за <span className="pricing-header__title-accent">сложную игру</span>
          </h1>
          <p className="pricing-header__sub">
            Никаких скрытых платежей. Отмените в любой момент. Базовый функционал — навсегда бесплатно.
          </p>
          <div className="pricing-toggle" role="tablist">
            <button
              role="tab"
              aria-selected={period === 'monthly'}
              className={period === 'monthly' ? 'pricing-toggle__btn pricing-toggle__btn--active' : 'pricing-toggle__btn'}
              onClick={() => setPeriod('monthly')}
            >
              Месяц
            </button>
            <button
              role="tab"
              aria-selected={period === 'yearly'}
              className={period === 'yearly' ? 'pricing-toggle__btn pricing-toggle__btn--active' : 'pricing-toggle__btn'}
              onClick={() => setPeriod('yearly')}
            >
              Год
              <span className="pricing-toggle__save">−17%</span>
            </button>
          </div>
        </div>
      </header>

      {/* ─── PLANS ───────────────────────────────────── */}
      <section className="pricing-plans">
        <div className="pricing-plans__grid">
          {PLANS.map((plan) => {
            const price = period === 'monthly' ? plan.priceMonthly : plan.priceYearly;
            const periodLabel = period === 'monthly' ? '/ мес' : '/ год';
            return (
              <article
                key={plan.id}
                className={`pricing-plan ${plan.highlighted ? 'pricing-plan--highlighted' : ''}`}
              >
                {plan.highlighted && <div className="pricing-plan__badge">Популярный</div>}
                <div className="pricing-plan__head">
                  <h3 className="pricing-plan__name">{plan.name}</h3>
                  <p className="pricing-plan__tag">{plan.tagline}</p>
                </div>
                <div className="pricing-plan__price">
                  {price === 0 ? (
                    <>
                      <span className="pricing-plan__price-value">0 ₽</span>
                      <span className="pricing-plan__price-period">навсегда</span>
                    </>
                  ) : (
                    <>
                      <span className="pricing-plan__price-value">{price.toLocaleString('ru-RU')} ₽</span>
                      <span className="pricing-plan__price-period">{periodLabel}</span>
                    </>
                  )}
                </div>
                <button
                  className={`pricing-plan__cta ${plan.highlighted ? 'pricing-plan__cta--primary' : ''}`}
                  onClick={() => handleCta(plan)}
                >
                  {plan.ctaLabel}
                </button>
                <ul className="pricing-plan__features">
                  {plan.features.map((f) => (
                    <li key={f}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      {/* ─── COMPARE ─────────────────────────────────── */}
      <section className="pricing-compare">
        <h2 className="pricing-compare__title">Подробное сравнение</h2>
        <div className="pricing-compare__table-wrap">
          <table className="pricing-compare__table">
            <thead>
              <tr>
                <th />
                {PLANS.map((p) => (
                  <th key={p.id}>{p.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  {row.values.map((v, i) => (
                    <td key={i}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ─── FAQ MINI ────────────────────────────────── */}
      <section className="pricing-faq">
        <h2 className="pricing-faq__title">Финансовые вопросы</h2>
        <div className="pricing-faq__grid">
          <div className="pricing-faq__item">
            <h3>Можно ли отменить подписку?</h3>
            <p>В любой момент. После отмены доступ сохраняется до конца оплаченного периода.</p>
          </div>
          <div className="pricing-faq__item">
            <h3>Возврат средств?</h3>
            <p>Полный возврат в течение 7 дней с момента оплаты, если что-то пошло не так.</p>
          </div>
          <div className="pricing-faq__item">
            <h3>Способы оплаты?</h3>
            <p>Банковские карты России и СНГ, СБП. Скоро — криптовалюты.</p>
          </div>
          <div className="pricing-faq__item">
            <h3>Скидки для команд?</h3>
            <p>Тариф Team уже учитывает скидку. Для клубов от 50 человек — индивидуальные условия.</p>
          </div>
        </div>
      </section>

      {/* ─── CTA ─────────────────────────────────────── */}
      <section className="pricing-cta">
        <div className="pricing-cta__inner">
          <h2 className="pricing-cta__title">Готовы начать?</h2>
          <p className="pricing-cta__text">
            Зарегистрируйтесь бесплатно — никаких карт, никаких ограничений по времени.
          </p>
          <button
            className="pricing-cta__btn"
            onClick={() => (isAuthenticated ? navigate('/app') : navigate('/auth'))}
          >
            {isAuthenticated ? 'В приложение' : 'Создать аккаунт'}
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z" />
            </svg>
          </button>
        </div>
      </section>
    </div>
  );
}
