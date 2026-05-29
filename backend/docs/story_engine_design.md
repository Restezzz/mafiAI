# Story Engine — design doc

**Status:** draft v1
**Author:** Cascade
**Date:** 2026-05-26
**Goal:** перевести всю игровую логику Мафии (порядок ходов, фразы диктора, паузы, ветвления по смертям) из Python-кода в редактируемый из админки граф этапов («сюжет»). Админ должен иметь возможность добавлять/удалять/перемещать шаги, загружать аудио, писать тексты с «караоке»-подсветкой, настраивать паузы и таймеры — **без правок исходного кода**.

---

## 1. Цели

### 1.1 Функциональные

1. **Граф сюжета в БД** вместо хардкода в `narration_script.py` + `game_engine.py`. Любой этап (ход роли, фраза диктора, голосование, развилка по смертям) — это запись в БД.
2. **Админ-редактор** на `/admin/stories` для CRUD сюжетов, шагов, переходов, фраз. Drag-n-drop редактор графа.
3. **Pre-game-настройки**:
   - `timer_multiplier` ∈ [0.5, 2.0] — общий множитель таймеров сюжета (вписывается числом с десятыми, не ползунком).
   - `inter_cue_pause_seconds` — пауза между фразами диктора (например 3.7 секунды).
4. **Караоке-подсветка** текста диктора синхронно с аудио (по словам).
5. **Death-branching**: «если умер шериф → играем вот эту фразу», «если победила мафия → финал A, иначе финал B» — настраивается edge-conditions в графе.
6. **Несколько сюжетов**: «Классическая Мафия», «Мафия с любовницей», «Маньяк-сценарий» — выбор в pre-game-лобби.

### 1.2 Нефункциональные

- **Обратная совместимость:** rollout под feature-flag, старый код остаётся пока новый не валидирован.
- **Recovery-safe:** перезапуск backend в середине ночи восстанавливает текущий шаг сюжета.
- **Idempotent migrations:** легко даунгрейдиться откатом миграции.
- **Production performance:** граф загружается eager-loadом одним запросом при старте сессии и кэшируется в `runtime_state`.

---

## 2. Анализ текущего состояния

### 2.1 Что захардкожено

#### 2.1.1 Порядок ходов ночи

`@c:/Users/Restez/Desktop/Mafia game/AI-GameMaster/backend/services/game_engine.py:1089`

```py
order = ["lover", "mafia", "don", "sheriff", "maniac", "doctor"]
```

Изменить порядок или вставить промежуточный шаг (например ритуальную фразу между мафией и шерифом) — невозможно без правки кода.

#### 2.1.2 Тексты и наборы фраз диктора

`@c:/Users/Restez/Desktop/Mafia game/AI-GameMaster/backend/services/narration_script.py` — 12 фабрик шагов:

| Функция | Привязка |
|---|---|
| `game_started_steps` | первая ночь, до подтверждения ролей |
| `all_acknowledged_steps` | после подтверждения ролей |
| `night_start_steps(phase_number)` | начало каждой ночи (фаза 1 ↔ остальные) |
| `turn_intro_steps(turn_slug, has_don)` | перед ходом каждой роли |
| `turn_outro_steps(turn_slug, has_don)` | после хода каждой роли |
| `night_result_steps(died_names, saved_name, blocked_name)` | результаты ночи |
| `day_discussion_steps` | начало дневной дискуссии |
| `day_voting_steps` | начало голосования |
| `vote_tie_steps` | ничья при голосовании |
| `vote_result_steps(eliminated_name, ...)` | результат голосования |
| `game_finished_steps(winner, ...)` | конец игры |
| `build_steps` | low-level builder |

Внутри функций — литералы текстов и slug'ов триггеров. Текст можно поменять только через релиз.

#### 2.1.3 Hardcoded паузы

- `@c:/Users/Restez/Desktop/Mafia game/AI-GameMaster/backend/services/game_engine.py:1064-1067` — после ходов шерифа/дона `await _wait_or_pause(session.id, 5)`. Жёстко 5 секунд.
- `_wait_seconds_for(announcement)` = только `duration_ms` шага. **Нет настраиваемой паузы между озвучками** диктора.

#### 2.1.4 Death-логика

`resolve_night` (`game_engine.py:1130+`) и `resolve_votes` (`game_engine.py:1551+`) — обработка убийств, перекрытия лечением, любовницы, win-condition. Все ветвления — в коде.

Специальные фразы по убитой роли (например «Шериф мёртв — мафия празднует») сейчас не возможны: `night_result_steps` принимает только список имён без ролей.

#### 2.1.5 Таймеры

`session.settings`:
- `role_reveal_timer_seconds`
- `night_action_timer_seconds`
- `discussion_timer_seconds`
- `voting_timer_seconds`

Дефолты захардкожены (30, 30, 120, 60). **Нет общего множителя** для всех таймеров одного сюжета.

### 2.2 Что уже в БД (фундамент готов)

| Таблица | Назначение |
|---|---|
| `narrator_audio_files` | физические mp3 |
| `narrator_triggers` | точки вызова (`mafia_eyes_open`, `one_killed` и т.п.) с `kind ∈ {variant, composite}` |
| `narrator_variants` | альтернативные тексты+аудио для variant-триггеров |
| `narrator_composite_templates` | шаблоны составных фраз |
| `narrator_composite_segments` | сегменты (audio + placeholder типа `{player_name}`) |
| `narrator_name_assets` | mp3 имён игроков для placeholder'ов |

То есть **«какие фразы есть»** — уже редактируется через админку. Не хватает только **«в каком порядке и при каких условиях их играть»** — это и есть story engine.

### 2.3 Frontend NarratorScreen

Сейчас отображает announcement через typewriter-эффект, синхронизированный по `duration_ms` всего шага. **Нет per-word подсветки**, поэтому если mp3 произносит слова неравномерно — текст и аудио рассинхронизируются.

Формат payload announcement:
```ts
{
  key: string;
  trigger: string;           // slug NarratorTrigger
  text: string;              // финальный текст после резолва placeholder'ов
  duration_ms: number;       // длительность шага
  audio_url?: string;        // для variant-кинда
  audio_segments?: {...}[];  // для composite-кинда
  step_index, steps_total, blocking, seed: ...
}
```

---

## 3. Концепция: сюжет как граф

### 3.1 Высокоуровнево

**Story** — это направленный граф из **Step**'ов, соединённых **Transition**'ами. Engine движется по графу:
```
load(current_step) → execute(step) → pick_next_step(transitions, conditions) → repeat
```

Каждый Step — атомарная единица. Каждый Transition может иметь condition (например «умер шериф»). Пустой condition = безусловный переход.

### 3.2 ER-диаграмма

```
┌────────────────────────┐       ┌──────────────────────┐
│        stories         │ 1 ── ∞│     story_steps      │
│ id, slug,              │       │ id, story_id, slug,  │
│ version,               │       │ kind, label,         │
│ name, description,     │       │ payload (jsonb),     │
│ is_active,             │       │ position_x, _y       │
│ is_obsolete,           │       └─────┬────────────┬───┘
│ superseded_by_id (FK), │             │1           │1
│ entry_step_id (FK)     │             │            │
│                        │             │∞           │∞
│ UNIQUE (slug, version) │    ┌────────▼─────────┐  │
└────────┬───────────────┘    │ story_narration_ │  │
         │1                   │       cues       │  │
         │                    │ id, step_id,     │  │
         │                    │ sort_order,      │  │
         │                    │ trigger_id (FK   │  │
         │                    │  narrator_       │  │
         │                    │  triggers),      │  │
         │                    │ pause_before_ms, │  │
         │                    │ pause_after_ms,  │  │
         │                    │ override_text,   │  │
         │                    │ override_durat-  │  │
         │                    │   ion_ms (null   │  │
         │                    │   = use audio)   │  │
         │                    └──────────────────┘  │
         │                                          │
         │                          ┌───────────────▼────────┐
         │                          │  story_transitions     │
         │                          │ id, story_id,          │
         │                          │ from_step_id,          │
         │                          │ to_step_id,            │
         │                          │ condition (jsonb),     │
         │                          │ priority               │
         │                          └────────────────────────┘
         │1
         │                          ┌────────────────────────────┐
         └────────────────────────► │   story_settings           │
                                    │ story_id (PK),             │
                                    │ inter_cue_pause_seconds    │
                                    │   (numeric 4.2 default 0), │
                                    │ timer_multiplier_default   │
                                    │   (numeric 3.2 def 1.0),   │
                                    │ karaoke_enabled bool       │
                                    └────────────────────────────┘
```

**Версионирование (см. §11.2):** один "логический" сюжет = серия записей `stories` с одним `slug` и разными `version`. UNIQUE `(slug, version)`. При update active-сюжета — создаётся новая запись с `version+1`, старая помечается `is_active=false`, `superseded_by_id` указывает на новую. Старая запись удаляется автоматически, когда нет ни одной `sessions` с `story_id = old`.

### 3.3 Виды Step (`kind`)

| `kind` | Назначение | `payload` пример |
|---|---|---|
| `narration` | проиграть набор фраз диктора | `{}` (cues — отдельная таблица) |
| `role_action` | ход роли (мафия/шериф/...) | `{"role_slug": "sheriff", "timer_setting": "night_action_timer_seconds", "skip_if_dead": true, "skip_if_blocked": true, "broadcast_action_required": true}` |
| `discussion` | дневная дискуссия | `{"timer_setting": "discussion_timer_seconds"}` |
| `voting` | голосование | `{"timer_setting": "voting_timer_seconds", "max_rounds": 2, "tie_handler": "random"}` |
| `night_resolve` | подсчёт жертв ночи | `{}` (стандартная логика kill - heal + maniac, lover-blocks) |
| `day_resolve` | резолв голосования + win-check | `{}` |
| `pause` | фиксированная пауза | `{"seconds": 2.5}` |
| `branch` | no-op, выбор edge по conditions | `{}` |
| `end` | финал игры | `{}` |

### 3.4 Виды Transition.condition

`null` — безусловный (default).

**Атомарные предикаты** (минимальные единицы):

| `type` | Параметры | Семантика |
|---|---|---|
| `role_alive` | `role_slug` | хотя бы один живой игрок этой роли |
| `role_dead` | `role_slug` | роль полностью выбита |
| `died_role` | `role_slug` | конкретно эта роль умерла на последнем step (night_resolve / day_resolve) |
| `death_cause` | `value: "vote" \| "night"` | последняя смерть причина |
| `winner` | `team: "city" \| "mafia" \| "maniac" \| null` | результат win-check'а |
| `phase_number` | `op: "==" \| ">=" \| "<=" \| "!=", value: int` | какая по счёту ночь/день |
| `vote_tie` | — | в голосовании ничья (используется в day_resolve) |
| `step_var` | `key`, `op` (==/!=/>=/<=/>/<), `value` | произвольная переменная в context |

**Композитные предикаты** (логические комбинаторы, рекурсивные):

| `type` | Параметры | Семантика |
|---|---|---|
| `all` | `conditions: list` | TRUE если все вложенные TRUE (AND) |
| `any` | `conditions: list` | TRUE если хотя бы один вложенный TRUE (OR) |
| `not` | `condition: object` | TRUE если вложенный FALSE |

Пример: «шериф мёртв И сейчас не первая фаза»:
```jsonc
{
  "type": "all",
  "conditions": [
    {"type": "died_role", "role_slug": "sheriff"},
    {"type": "phase_number", "op": ">=", "value": 2}
  ]
}
```

Пример: «мафия победила ИЛИ маньяк победил» (обработать один и тот же финал):
```jsonc
{
  "type": "any",
  "conditions": [
    {"type": "winner", "team": "mafia"},
    {"type": "winner", "team": "maniac"}
  ]
}
```

Глубина вложенности любая. Для производительности на runtime — каждое условие eval-ится short-circuit (`all` останавливается на первом FALSE, `any` — на первом TRUE).

`priority` — если несколько transitions подходят, выбирается с **наибольшим** priority. Безусловный edge ставится с priority=0 (catch-all).

---

## 4. Пример: как «Классическая Мафия» ложится в граф

(Сокращённо — реальный seed будет ~30 step'ов.)

```
[start]
  │ unconditional
  ▼
┌─────────────────────────┐
│ narration: "правила"    │  cues: [rules_trigger]
│ kind=narration          │
└─────────────────────────┘
  │ unconditional
  ▼
┌─────────────────────────┐
│ narration: "ack_done"   │  cues: [intro_personality]
└─────────────────────────┘
  │ unconditional
  ▼
┌─────────────────────────┐
│ narration: "night_start"│  cues: [first_night_poem]   (priority=10, condition=phase_number==1)
└─────────────────────────┘                              cues: [rest_night_intro] (priority=0)
  │ unconditional
  ▼
┌─────────────────────────┐
│ narration: lover_intro  │  cues: [lover_intro]
└─────────────────────────┘
  │ unconditional
  ▼
┌─────────────────────────┐
│ role_action: lover      │  payload.role_slug=lover
└─────────────────────────┘
  │ unconditional
  ▼
┌─────────────────────────┐
│ narration: lover_outro  │
└─────────────────────────┘
  │ ...
  │ (mafia → don → sheriff → maniac → doctor аналогично)
  │
  ▼
┌─────────────────────────┐
│ night_resolve           │
└─────────────────────────┘
  │
  ├─── condition: winner!=null    → end
  │
  ├─── condition: died_role=sheriff (priority=20)
  │     ▼
  │   narration: "шериф мёртв" (новая фраза)
  │     │
  │     ▼ unconditional
  │   narration: night_result
  │
  └─── unconditional (priority=0)
        ▼
      narration: night_result
        │
        ▼
      discussion → voting → day_resolve → ...
```

Главное — **мест для вставки новых ветвлений сколько угодно**, и всё через UI.

---

## 5. Engine: spec executor'а

### 5.1 Псевдокод

```py
class StoryRuntime:
    story_id: UUID
    current_step_id: UUID
    multiplier: float  # из session.settings.timer_multiplier
    context: dict      # last_died_role, last_died_cause, winner, vote_tie ...

async def run_story(session_id):
    rt = StoryRuntime.load(session_id)  # или resume из persisted state
    while True:
        step = await get_step(rt.current_step_id)
        result = await execute_step(step, rt)
        if step.kind == "end" or rt.game_finished:
            break
        next_step = await pick_next(step, rt)
        rt.advance_to(next_step)

async def pick_next(step, rt):
    transitions = await get_transitions_from(step.id)  # ordered by priority desc
    for t in transitions:
        if eval_condition(t.condition, rt):
            return await get_step(t.to_step_id)
    raise StoryDeadEnd(step.id)  # ловится ERROR-логом + fallback на end
```

### 5.2 Handler'ы по kind

| Step kind | Handler |
|---|---|
| `narration` | для каждого cue: `_play_phase_announcements([cue])` + sleep(`pause_after_ms` × multiplier) с inter_cue_pause из настроек |
| `role_action` | то же что `_run_turn(role_slug, seconds × multiplier)` |
| `discussion` | то же что `transition_to_day` (старт таймера discussion_timer × multiplier) |
| `voting` | то же что `transition_to_voting` |
| `night_resolve` | старая `resolve_night` логика, но без последующего перехода → возвращает `last_died_role`, `winner` в context |
| `day_resolve` | старая `resolve_votes` логика, аналогично |
| `pause` | `await _wait_or_pause(seconds × multiplier)` |
| `branch` | no-op, сразу pick_next |
| `end` | `finish_game(...)` с context.winner |

### 5.3 Multiplier применение

```py
effective_seconds = base_seconds * rt.multiplier
```

- Для всех `_timer_seconds` settings.
- Для всех `pause` step'ов.
- Для `inter_cue_pause_seconds`.
- **Не** применяется к `duration_ms` mp3 (длина аудио физическая, её менять нельзя).

### 5.4 Recovery после рестарта

`SessionRuntime` (`runtime_state.py`) расширяется:
```py
@dataclass
class SessionRuntime:
    ...
    story_id: UUID | None = None
    current_step_id: UUID | None = None
    story_context: dict = field(default_factory=dict)
```

Сериализуется в `GamePhase.payload` или новой колонке `Session.story_state` после каждого `advance_to`. При старте `recover_session` читает оттуда и продолжает с `current_step_id`.

---

## 6. Pre-game настройки

### 6.1 Расширение `session.settings`

```jsonc
{
  // существующие
  "discussion_timer_seconds": 120,
  "voting_timer_seconds": 60,
  "night_action_timer_seconds": 30,
  "role_reveal_timer_seconds": 30,
  "role_config": {...},

  // новые
  "story_id": "uuid-of-story",
  "timer_multiplier": 1.0,            // 0.5..2.0, default из story_settings
  "inter_cue_pause_seconds": 3.7      // override story_settings.inter_cue_pause_seconds
}
```

### 6.2 UI

В `SessionSettingsForm`:

- **Сюжет** (select) — список `is_active=true` сюжетов
- **Множитель таймеров** (number input, step=0.1, min=0.5, max=2.0) — default 1.0, отображение «Например: 1.5x = таймеры на 50% длиннее»
- **Пауза между фразами диктора** (number input, step=0.1, min=0.0, max=10.0) — секунды с десятыми

---

## 7. Karaoke (per-word подсветка)

### 7.1 Подход

Админ при добавлении mp3 в cue (или в narrator_variant) пишет текстовку фразы. На runtime подсветка подсвечивает слова **равномерно по длине аудио**: для каждого слова рассчитывается `start_ms = i * dur_ms / N` (N — число слов в тексте). Никаких ручных таймингов, никакого whisper — это «работает из коробки» сразу, без отдельной инфры.

Этого достаточно для MVP. **Future work (за пределами текущего roadmap):** автоматическая whisper-разметка с возможностью ручной правки кривых таймингов через UI. Закладываем под это поле `word_timings jsonb` сразу (см. §7.2), но в этапе 5 заполняем только fallback'ом и читаем equally-spaced если поле пустое.

### 7.2 Модель данных

Новая колонка `narrator_variants.word_timings jsonb` (nullable, default null):
```jsonc
// null  → frontend применяет equally-spaced (по text + duration_ms)
// массив → используется как авторитативная разметка
[
  {"word": "Мафия,", "start_ms": 0, "end_ms": 480},
  {"word": "откройте", "start_ms": 480, "end_ms": 1100},
  {"word": "глаза!", "start_ms": 1100, "end_ms": 1750}
]
```

Аналогично можно расширить `narrator_composite_segments.word_timings` для composite. **В этапе 5 — только variants, composite позже.**

### 7.3 WS payload расширение

```jsonc
{
  "type": "announcement",
  "payload": {
    "trigger": "mafia_eyes_open",
    "text": "Мафия, откройте глаза!",
    "duration_ms": 1750,
    "audio_url": "/audio/...",
    "word_timings": null  // или массив, если есть разметка
  }
}
```

### 7.4 Frontend rendering

```tsx
// NarratorScreen.tsx
const timings = payload.word_timings ?? computeEquallySpaced(payload.text, payload.duration_ms);
{timings.map((w, i) => (
  <span className={i === activeIdx ? 'word word--active' : 'word'}>
    {w.word}{' '}
  </span>
))}
```

`activeIdx` обновляется по `audio.currentTime` через `requestAnimationFrame`. `computeEquallySpaced` — pure frontend-функция, не требует backend-расчёта.

---

## 8. Death-branching: примеры

### 8.1 Особая фраза при смерти шерифа

```
[night_resolve]
  ├── priority=20, condition: died_role=sheriff
  │     → [narration "шериф_мёртв"]
  │           → [narration "общий_итог_ночи"]
  │
  └── priority=0 (catch-all)
        → [narration "общий_итог_ночи"]
```

### 8.2 Победа мафии = другой финал чем победа города

```
[day_resolve]
  ├── priority=20, condition: winner=mafia
  │     → [narration "мафия_победила"] → [end]
  │
  ├── priority=20, condition: winner=city
  │     → [narration "город_победил"] → [end]
  │
  └── priority=0 (catch-all)
        → [narration "перешли_в_ночь"]
        → [narration "next_night_intro"]
        → ...
```

---

## 9. API спека

### 9.1 Stories CRUD

```
GET    /api/admin/stories                       → list (id, slug, name, is_active, version)
POST   /api/admin/stories                       → create
GET    /api/admin/stories/{id}                  → full (со steps + transitions + cues + settings)
PUT    /api/admin/stories/{id}                  → update (name, description, is_active, settings)
DELETE /api/admin/stories/{id}                  → soft-delete (is_active=false; запрещено если активная сессия использует)
POST   /api/admin/stories/{id}/duplicate        → клон с suffix-slug-ом
GET    /api/admin/stories/{id}/export           → JSON-снапшот всего графа
POST   /api/admin/stories/import                → import из JSON
```

### 9.2 Steps CRUD

```
POST   /api/admin/stories/{id}/steps            → создать step
PUT    /api/admin/stories/{id}/steps/{step_id}  → обновить (kind/label/payload/position_xy)
DELETE /api/admin/stories/{id}/steps/{step_id}  → удалить (каскадно: cues + входящие/исходящие transitions)
POST   /api/admin/stories/{id}/entry            → выставить entry_step_id
```

### 9.3 Transitions CRUD

```
POST   /api/admin/stories/{id}/transitions      → {from_step_id, to_step_id, condition, priority}
PUT    /api/admin/stories/{id}/transitions/{t_id}
DELETE /api/admin/stories/{id}/transitions/{t_id}
```

### 9.4 Narration cues

```
GET    /api/admin/stories/{id}/steps/{step_id}/cues  → list ordered
POST   /api/admin/stories/{id}/steps/{step_id}/cues  → создать
PUT    /api/admin/stories/{id}/cues/{cue_id}         → обновить
DELETE /api/admin/stories/{id}/cues/{cue_id}
POST   /api/admin/stories/{id}/steps/{step_id}/cues/reorder  → bulk reorder ([cue_id, ...])
```

### 9.5 Word-timings

```
GET    /api/admin/narrator/variants/{v_id}/word-timings   → текущие
PUT    /api/admin/narrator/variants/{v_id}/word-timings   → set/replace
POST   /api/admin/narrator/variants/{v_id}/word-timings/auto  → пересчитать equally-spaced
```

### 9.6 Validation

При сохранении story:
- Все steps достижимы из entry_step_id (BFS)
- Нет dead-end'ов (каждый non-end step имеет ≥1 transition)
- Все referenced trigger_id'ы существуют
- Все referenced role_slug'и есть в `ROLE_CATALOG`
- Условия валидны (типы и значения)

Возвращается список ошибок до commit'а — не даём сохранить inconsistent граф.

---

## 10. Migration plan: legacy → story

### 10.1 Seed «Классическая Мафия»

Single Alembic migration после создания таблиц:

```py
def upgrade():
    # ... create_table ...
    # Seed Story
    story_id = uuid.uuid4()
    op.bulk_insert(stories_table, [{
        "id": story_id,
        "slug": "classic_mafia",
        "name": "Классическая Мафия",
        "version": 1,
        "is_active": True,
        ...
    }])
    # Seed StorySteps (~30): по одной записи на каждый старый turn_intro_steps + turn_outro_steps + ...
    # Seed StoryTransitions (~40): unconditional между ними + branch'и для phase==1
    # Seed StoryNarrationCues: ссылки на NarratorTrigger.slug которые УЖЕ в БД
```

Скрипт `scripts/dump_legacy_story.py` — генерирует seed-INSERT'ы из текущих функций `narration_script.py`. Запускается один раз, результат коммитится в миграцию.

### 10.2 Compatibility flag

```py
# session.settings.use_story_engine: bool (default false)
if session.settings.get("use_story_engine"):
    await run_story(session_id)
else:
    await transition_to_night(session_id, 1)  # legacy путь
```

После полной валидации (этап 7) флаг становится `true` дефолтом, а потом удаляется вместе с legacy кодом.

---

## 11. Этапы

### 11.1 Roadmap

| Этап | Deliverable | Безопасность |
|---|---|---|
| **1** | Модели Story* + миграция + seed legacy + admin CRUD API + import/export JSON | Read-only, gameplay не трогается |
| **2** | StoryRuntime executor + переделанная GamePhase model + сериализация current_step_id в session | Прод default = legacy через `use_story_engine` flag |
| **3** | Pre-game settings (multiplier, inter_cue_pause) в backend + UI form | Влияет только если flag=true |
| **4** | Admin UI редактор графа на `@xyflow/react` (drag-n-drop nodes, sidebar editor) | Read-only safe |
| **5** | Karaoke: text + equally-spaced подсветка в NarratorScreen, поле `word_timings` (заготовка) | Fallback на typewriter |
| **6** | Death-branching UI + composite conditions (all/any/not) + admin CRUD ролей (для расширения колоды) | Read-only safe |
| **7** | `use_story_engine = true` дефолт + удаление legacy кода (`narration_script.py`, ветки в `game_engine.py`) | Прод миграция |

После каждого этапа — отдельный commit без push. Финальный merge — после прохождения этапов 1–7.

### 11.2 Версионирование сюжетов

**Стратегия:** каждое обновление активного сюжета создаёт новую запись `Story` с `version+1`.

Жизненный цикл:
1. Admin создаёт `classic_mafia v1`, `is_active=true`. 
2. Lobby стартует сессию: `session.settings.story_id = v1.id`. 
3. Admin редактирует сюжет через UI: backend клонирует `v1` → создаёт `v2` со всеми steps/transitions/cues/settings, `v1.is_active=false`, `v1.superseded_by_id=v2.id`, `v2.is_active=true`. 
4. Pre-game-лобби нового lobby видит только `v2` (фильтр `is_active=true AND is_obsolete=false`). Сессия с `story_id=v1` продолжает играть на `v1` — её граф не меняется. 
5. Когда `session(story_id=v1)` финиширует — фоновый cleanup (`recovery_loop` или отдельный таймер) проверяет: есть ли ещё `sessions WHERE story_id=v1 AND status IN ('lobby','active')`? Если нет — `DELETE FROM stories WHERE id=v1`. Каскадно удаляются steps/transitions/cues/settings.

Поле `is_obsolete=true` (вместо удаления) используется только если у админа есть какая-то причина оставить старую версию в БД для аудита, но это не дефолт. Дефолт — hard-delete.

**UNIQUE** на уровне Postgres: `UNIQUE (slug, version)`. 
**Полу-индекс** для быстрого поиска активной версии: `CREATE UNIQUE INDEX ix_stories_active_slug ON stories(slug) WHERE is_active = TRUE`. Гарантирует ровно один is_active=true на slug.

---

## 12. Открытые вопросы (нужны ответы перед стартом)

> Эти вопросы я задам после того как ты прочитаешь и оставишь свои комментарии. Можешь ответить на них прямо в этом документе или после.

1. **Несколько сюжетов или один?** Ответ: Будет несколько сюжетов.

2. **Роли в граф?** Сейчас роли (`mafia`, `sheriff`, ...) живут в отдельной таблице `roles`. Сюжет может предполагать **дополнительные роли** (например «прокурор»). Тогда сначала нужен админ-CRUD ролей. Это **отдельный** проект — выносим за скобки или включаем в этап 6? Ответ: да, включаем в этап 6.

3. **Импорт/экспорт сюжета:** нужен ли сразу в первой версии (этап 1)? Удобно для бекапов и переноса между окружениями. Ответ: давай

4. **Karaoke source:** соглашаешься на equally-spaced fallback для MVP? Или хочется сразу whisper-разметку? (Whisper = отдельная инфра-задача: установка `whisperX`, GPU/CPU воркер, очередь). Ответ: не уверен насчёт ручной расстановки. меня привлекает вариант, что по дефолту будет просто растягиваться караоке подсветка в зависимости от длинны аудио, а как доп. функция - возможность через виспер единожды обработать каждое mp3 расписав тайминги и потом уже вручную их подредачить, если будет кривой перевод (или тайминг). но это пока что лишнее, сделай просто возможность при добавлении мп3 в сюжет приписать текст, который как раз будет загораться равномерно от длины аудио.

5. **Переменные сюжета (`step_var`):** простой `branch` пока работает только на «died_role / winner / phase_number». Хочется ли уже сейчас более выразительный язык условий (например AND/OR-композиции)? Или достаточно «один condition на edge»? Ответ: давай с более выразительным языком условий.

6. **Visual editor library:** предлагаю `@xyflow/react` (бывший reactflow) — лидер в области node-based UI, поддерживается. Альтернатива — самопал на DOM. Согласен на reactflow? Ответ: не знаю, я не разбираюсь - решай сам.

7. **Версионирование сюжетов:** при правке active-сюжета во время игры на проде — что делать? Варианты:
   - Запретить редактирование active-сюжетов (нужно сделать `is_active=false`, отредактировать, опять `is_active=true`)
   - Версионировать: правка создаёт `version+1`; активные сессии продолжают на старой версии, новые сессии берут новую
   - Snapshot: при старте сессии копируется snapshot графа в `session.story_snapshot jsonb`, сессия играет по snapshot'у
   - Сейчас (MVP): просто запретить править active-сюжет

   Какой подход предпочитаешь? Ответ: версионировать, когда все активные сессии доигрываются на старой версии - она автоматически удаляется.

8. **Phase model в БД:** сейчас `GamePhase.phase_type` ∈ `{role_reveal, night, day}`. С story-engine это становится менее точным (внутри одного `night` может быть много шагов с разной семантикой). Оставляем `GamePhase` как есть (для UI-индикатора «ночь/день») и добавляем `current_step_id` рядом? Или переделываем `GamePhase` целиком? Ответ: переделываем целиком
---

## 13. TL;DR

- Граф из `Story → StoryStep → StoryTransition` + `StoryNarrationCue` для фраз
- 9 типов шагов, 8 атомарных предикатов + 3 композитных (all/any/not, рекурсивно)
- Engine = walker по графу с `multiplier` и `context`
- Версионирование: правка создаёт новую `version+1`, старая живёт до окончания текущих сессий, затем cleanup
- Karaoke = equally-spaced по `text + duration_ms`, поле `word_timings jsonb` под future work с whisper
- Editor библиотека: `@xyflow/react`
- Этап 2 переделывает `GamePhase` модель целиком
- Этап 6 расширяется на CRUD ролей (для добавления «прокурора» и т.п.)
- 7 этапов, коммит после каждого без push

---

## 14. Гигиена админки (отдельный hot-fix)

Независимые от story-engine задачи, требующие фикса до начала тестирования сюжетов на real-сессиях:

### 14.1 Список активных сессий в админке

Новый раздел `/admin/sessions/active` (или вкладка):
- Таблица: `id`, `code`, `host_email`, `players_count`, `phase`, `started_at`, `last_activity_at`, действие «Прервать»
- Endpoint `GET /api/admin/sessions/active?status=active,lobby` — paginate
- Endpoint `POST /api/admin/sessions/{id}/abort` — переводит сессию в `status='aborted'`, шлёт WS `session_aborted` всем клиентам, чистит таймеры/runtime, генерирует `GameEvent(type='admin_aborted')`

### 14.2 Audit abandoned sessions

Проверить как обрабатывается сессия после всех disconnect'ов:
- В `game_engine.py` есть ли логика «если все игроки disconnected > X минут → session.status = 'abandoned'`?
- Если нет — добавить фоновый таймер в `recovery_loop`: каждые 60s проходит по `sessions WHERE status IN ('lobby','active')`, для каждой смотрит `last_player_activity_at` (нужно добавить колонку или использовать `players.last_seen_at`), если все > 30 минут — abort
- Цель: чтобы админская таблица §14.1 не показывала «трупы» сессий

### 14.3 Синтетические игроки

Сейчас тест-игроки создаются с фейк-email и попадают в `users`. После окончания тест-сессии остаются в БД и засоряют админку.

Решения:
- **A (предпочтительный):** ввести флаг `users.is_synthetic bool`. Юзеры с этим флагом не показываются в админ-таблице юзеров. После `session.status IN ('completed', 'aborted', 'abandoned')` фоновый job удаляет всех `users WHERE is_synthetic=true AND NOT EXISTS (SELECT 1 FROM players p WHERE p.user_id = users.id AND p.session.status IN ('lobby','active'))`.
- **B:** хранить тест-игроков в отдельной таблице `synthetic_players` без записи в `users`. Более чистая модель, но требует переделки auth/lobby.

Для hot-fix — выбираем A. B — в backlog.

### 14.4 Этапность hot-fix'а

Как отдельный коммит **после** этапа 1 (чтобы не блокировать story engine), но **до** этапа 7. Реалистично совместить с этапом 4 (admin UI). Если приоритет высокий — могу сделать сразу после §1, до §2.

---

Готов стартовать **этап 1** после согласования.
