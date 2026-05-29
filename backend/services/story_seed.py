"""Идемпотентный seed «Классической Мафии» в Story Engine.

Восстанавливает граф сюжета на основе текущего хардкода в
``services/narration_script.py`` + порядка ходов из
``services/game_engine.execute_night_sequence``.

Запускается:
- Автоматически в lifespan startup (см. ``main.py``), по аналогии с
  ``ensure_role_catalog``.
- Вручную: ``python -m services.story_seed`` (см. ``__main__`` ниже).

Идемпотентность: если уже существует ``Story(slug='classic_mafia',
version=1)`` — функция возвращается без изменений. Перезагрузить граф
заново (например после правок) — удалить запись через admin UI или
напрямую SQL ``DELETE FROM stories WHERE slug='classic_mafia'``, потом
вызвать seed повторно.

Триггеры (`NarratorTrigger.slug`) ожидаются в БД (созданы через
``20260518_narrator_tables`` миграцию + ``scripts/migrate_narrator_to_db.py``).
Если какого-то триггера нет — cue создаётся с ``trigger_id=None``, в
override_text сохраняется fallback-текст из narration_script.py. Это
позволяет seed'у не падать на полу-настроенных окружениях.

Структура графа (ветки → ноды → cues) описана в design doc §4.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import async_session_factory
from core.logging import log_event
from models.narrator import NarratorTrigger
from models.story import (
    Story,
    StoryNarrationCue,
    StorySettings,
    StoryStep,
    StoryTransition,
)


logger = logging.getLogger(__name__)


CLASSIC_MAFIA_SLUG = "classic_mafia"
CLASSIC_MAFIA_VERSION = 1


# Fallback-тексты для триггеров, отсутствующих в БД.
# Дублируются из narration_script.py чтобы seed работал даже на холодной БД.
_TRIGGER_FALLBACK_TEXTS: dict[str, str] = {
    "rules": (
        "И так... давайте озвучим правила.... Мирные жители и мафия, а также "
        "дополнительные роли, слушайте внимательно) Суть игры — в противостоянии "
        "команд: горожане стремятся вычислить мафию, а те, напротив, убить всех мирных."
    ),
    "intro_personality": (
        'Я надеюсь, что все запомнили свои роли, определились со своей "личностью", '
        "предлагаю начинать игру!"
    ),
    "intro_poem": (
        "День пройден обычно, спускается ночь,\nИ мирным никто не сумеет помочь.\n"
        "Город засыпает, закрываем глазки,\nМафия выходит, надевает маски!"
    ),
    "end_day_start_night_2": "Пришло время ночи! Город засыпает!",
    "lover_intro": (
        "Конечно же, ночью не дремлет любовь… Любовница, откройте глаза и выберите "
        "своего возлюбленного для ночных удовольствий"
    ),
    "lover_outro": (
        "Любовница выбрала возлюбленного, у кого-то будет прекрасная ночь! "
        "Закрывайте глаза, девушка"
    ),
    "mafia_exit_poem": "На улице тихо, весь город уснул, но в тёмном районе — преступный разгул",
    "mafia_eyes_open": "Мафия, откройте глаза!",
    "mafia_choose": "Мафия делает свой выбор...",
    "mafia_choice_made": "Что ж, выбор был сделан",
    "mafia_eyes_close": "Мафия возвращается домой, закройте глаза",
    "mafia_eyes_close_don_chooses": (
        "Мафия покидает место преступления, закройте глаза, а Дон Мафия, "
        "проверьте по списку вашего преследователя!"
    ),
    "don_eyes_close": "К Дон Мафии пришло досье... ответ прочитан... закройте глаза",
    "sheriff_wakes": (
        "Я надеюсь, уже вся мафия скрылась в ночи, пришло время ночного смотрителя, "
        "просыпается шериф!"
    ),
    "sheriff_chooses": "Шериф, сделайте свой выбор, на кого направлено ваше расследование?",
    "sheriff_chose": "Шериф уже устал за эту ночь... расследование окончено... закройте глаза",
    "maniac_intro_1": "Убийства ещё не закончены... в городе полно сумасшедших людей",
    "maniac_intro_2": (
        "Маньяк знает все улочки этого тёмного города... откройте глаза и выберите "
        "вашу сегодняшнюю жертву"
    ),
    "maniac_outro": "Уф… маньяк сделал свой выбор, закрывайте глаза..",
    "doctor_eyes_open": (
        "Многие уже ушли спать, но доктор всё ещё работает.. Доктор, откройте глаза, "
        "чтобы спасти невинную душу"
    ),
    "doctor_eyes_close": "Доктор отработал смену, закрывайте глаза",
    "morning_intro": (
        "Вот и прошла напряжённая ночь, город просыпается, пора узнать результаты!"
    ),
    "after_night_result": "И так, результаты объявлены, переходим к обсуждению!",
    "after_discussion": "И так, обсуждение закончилось, переходим к голосованию!",
    "after_voting": (
        "Чтож, по результатам голосования был изгнан игрок... игра продолжается…!"
    ),
    "city_win_post": "В этой игре победили мирные!",
    "mafia_win_post": "В этой игре победила мафия!",
    "maniac_win_post": "В этой игре победил маньяк!",
}


# Описание шагов сюжета. Каждый словарь — будущий StoryStep.
# Поле ``cues`` — список (sort_order, trigger_slug, override_text|None) для
# narration-step'ов.
#
# Графовая структура (см. design doc §4):
#   entry → rules → intro_personality → night_start_decision (branch)
#                 → night_start_first / night_start_late → lover_intro
#                 → ROLE-LOOP (lover/mafia/don/sheriff/maniac/doctor)
#                 → night_resolve → winner_check (branch)
#                   → mafia_won/city_won/maniac_won → end
#                   → night_result → day_discussion_intro → day_discussion
#                   → day_voting_intro → day_voting → day_resolve
#                   → vote_winner_check (branch)
#                     → mafia_won/city_won/maniac_won → end
#                     → vote_result → night_start_decision (LOOP)
_STEPS: list[dict[str, Any]] = [
    # ────────────────────── intro ──────────────────────
    {
        "slug": "rules",
        "kind": "narration",
        "label": "Объявить правила",
        "cues": [("rules",)],
    },
    {
        "slug": "intro_personality",
        "kind": "narration",
        "label": "Подтверждение готовности",
        "cues": [("intro_personality",)],
    },
    # ──────────────────── night start ────────────────────
    {
        "slug": "night_start_decision",
        "kind": "branch",
        "label": "Какая ночь?",
        # При входе в этот branch создаётся новая GamePhase(night, N+1).
        # phase_number в step_vars увеличивается на 1.
        "payload": {"phase_action": "enter_night"},
    },
    {
        "slug": "night_start_first",
        "kind": "narration",
        "label": "Первая ночь — стих",
        "cues": [("intro_poem",)],
    },
    {
        "slug": "night_start_late",
        "kind": "narration",
        "label": "Очередная ночь",
        "cues": [("end_day_start_night_2",)],
    },
    # ──────────────────── lover ────────────────────
    {
        "slug": "lover_intro",
        "kind": "narration",
        "label": "Любовница: вступление",
        "cues": [("lover_intro",)],
    },
    {
        "slug": "lover_action",
        "kind": "role_action",
        "label": "Любовница: ход",
        "payload": {
            "role_slug": "lover",
            "timer_setting": "night_action_timer_seconds",
            "skip_if_dead": True,
        },
    },
    {
        "slug": "lover_outro",
        "kind": "narration",
        "label": "Любовница: завершение",
        "cues": [("lover_outro",)],
    },
    # ──────────────────── mafia ────────────────────
    {
        "slug": "mafia_intro",
        "kind": "narration",
        "label": "Мафия: вступление",
        "cues": [
            ("mafia_exit_poem",),
            ("mafia_eyes_open",),
            ("mafia_choose",),
        ],
    },
    {
        "slug": "mafia_action",
        "kind": "role_action",
        "label": "Мафия: ход",
        "payload": {
            "role_slug": "mafia",
            "timer_setting": "night_action_timer_seconds",
            "skip_if_dead": True,
        },
    },
    {
        "slug": "mafia_outro",
        "kind": "narration",
        "label": "Мафия: завершение",
        "cues": [
            ("mafia_choice_made",),
            ("mafia_eyes_close",),
        ],
    },
    # ──────────────────── don ────────────────────
    {
        "slug": "don_intro",
        "kind": "narration",
        "label": "Дон: вступление",
        "cues": [("mafia_eyes_close_don_chooses",)],
    },
    {
        "slug": "don_action",
        "kind": "role_action",
        "label": "Дон: ход",
        "payload": {
            "role_slug": "don",
            "timer_setting": "night_action_timer_seconds",
            "skip_if_dead": True,
        },
    },
    {
        "slug": "don_outro",
        "kind": "narration",
        "label": "Дон: завершение",
        "cues": [("don_eyes_close",)],
    },
    # ──────────────────── sheriff ────────────────────
    {
        "slug": "sheriff_intro",
        "kind": "narration",
        "label": "Шериф: вступление",
        "cues": [
            ("sheriff_wakes",),
            ("sheriff_chooses",),
        ],
    },
    {
        "slug": "sheriff_action",
        "kind": "role_action",
        "label": "Шериф: ход",
        "payload": {
            "role_slug": "sheriff",
            "timer_setting": "night_action_timer_seconds",
            "skip_if_dead": True,
        },
    },
    {
        "slug": "sheriff_outro",
        "kind": "narration",
        "label": "Шериф: завершение",
        "cues": [("sheriff_chose",)],
    },
    # ──────────────────── maniac ────────────────────
    {
        "slug": "maniac_intro",
        "kind": "narration",
        "label": "Маньяк: вступление",
        "cues": [
            ("maniac_intro_1",),
            ("maniac_intro_2",),
        ],
    },
    {
        "slug": "maniac_action",
        "kind": "role_action",
        "label": "Маньяк: ход",
        "payload": {
            "role_slug": "maniac",
            "timer_setting": "night_action_timer_seconds",
            "skip_if_dead": True,
        },
    },
    {
        "slug": "maniac_outro",
        "kind": "narration",
        "label": "Маньяк: завершение",
        "cues": [("maniac_outro",)],
    },
    # ──────────────────── doctor ────────────────────
    {
        "slug": "doctor_intro",
        "kind": "narration",
        "label": "Доктор: вступление",
        "cues": [("doctor_eyes_open",)],
    },
    {
        "slug": "doctor_action",
        "kind": "role_action",
        "label": "Доктор: ход",
        "payload": {
            "role_slug": "doctor",
            "timer_setting": "night_action_timer_seconds",
            "skip_if_dead": True,
        },
    },
    {
        "slug": "doctor_outro",
        "kind": "narration",
        "label": "Доктор: завершение",
        "cues": [("doctor_eyes_close",)],
    },
    # ──────────────────── night resolve & morning ────────────────────
    {
        "slug": "night_resolve",
        "kind": "night_resolve",
        "label": "Подсчёт жертв ночи",
    },
    {
        "slug": "night_winner_check",
        "kind": "branch",
        "label": "Победа после ночи?",
    },
    {
        "slug": "night_result",
        "kind": "narration",
        "label": "Утренние новости",
        "cues": [("morning_intro",)],
    },
    # ──────────────────── day ────────────────────
    {
        "slug": "day_discussion_intro",
        "kind": "narration",
        "label": "Объявление дискуссии",
        # Первый дневной шаг — создаём GamePhase(day, N).
        "payload": {"phase_action": "enter_day"},
        "cues": [("after_night_result",)],
    },
    {
        "slug": "day_discussion",
        "kind": "discussion",
        "label": "Дневная дискуссия",
        "payload": {"timer_setting": "discussion_timer_seconds"},
    },
    {
        "slug": "day_voting_intro",
        "kind": "narration",
        "label": "Объявление голосования",
        "cues": [("after_discussion",)],
    },
    {
        "slug": "day_voting",
        "kind": "voting",
        "label": "Голосование",
        "payload": {
            "timer_setting": "voting_timer_seconds",
            "max_rounds": 2,
            "tie_handler": "random",
        },
    },
    {
        "slug": "day_resolve",
        "kind": "day_resolve",
        "label": "Резолв голосования",
    },
    {
        "slug": "day_winner_check",
        "kind": "branch",
        "label": "Победа после дня?",
    },
    {
        "slug": "vote_result",
        "kind": "narration",
        "label": "Результат голосования",
        "cues": [("after_voting",)],
    },
    # ──────────────────── endings ────────────────────
    {
        "slug": "city_won",
        "kind": "narration",
        "label": "Победа мирных",
        # Сначала фиксируем sessions.status='finished', потом играем фразу.
        "payload": {"phase_action": "enter_finished"},
        "cues": [("city_win_post",)],
    },
    {
        "slug": "mafia_won",
        "kind": "narration",
        "label": "Победа мафии",
        "payload": {"phase_action": "enter_finished"},
        "cues": [("mafia_win_post",)],
    },
    {
        "slug": "maniac_won",
        "kind": "narration",
        "label": "Победа маньяка",
        "payload": {"phase_action": "enter_finished"},
        "cues": [("maniac_win_post",)],
    },
    {
        "slug": "end",
        "kind": "end",
        "label": "Конец игры",
    },
]


# Рёбра графа. Формат: (from_slug, to_slug, condition|None, priority).
# Безусловные edges имеют priority=0, специализированные — выше.
_TRANSITIONS: list[tuple[str, str, dict[str, Any] | None, int]] = [
    # Intro
    ("rules", "intro_personality", None, 0),
    ("intro_personality", "night_start_decision", None, 0),
    # Night start: первая ночь vs остальные
    (
        "night_start_decision",
        "night_start_first",
        {"type": "phase_number", "op": "==", "value": 1},
        10,
    ),
    ("night_start_decision", "night_start_late", None, 0),
    ("night_start_first", "lover_intro", None, 0),
    ("night_start_late", "lover_intro", None, 0),
    # Lover
    ("lover_intro", "lover_action", None, 0),
    ("lover_action", "lover_outro", None, 0),
    ("lover_outro", "mafia_intro", None, 0),
    # Mafia
    ("mafia_intro", "mafia_action", None, 0),
    ("mafia_action", "mafia_outro", None, 0),
    ("mafia_outro", "don_intro", None, 0),
    # Don
    ("don_intro", "don_action", None, 0),
    ("don_action", "don_outro", None, 0),
    ("don_outro", "sheriff_intro", None, 0),
    # Sheriff
    ("sheriff_intro", "sheriff_action", None, 0),
    ("sheriff_action", "sheriff_outro", None, 0),
    ("sheriff_outro", "maniac_intro", None, 0),
    # Maniac
    ("maniac_intro", "maniac_action", None, 0),
    ("maniac_action", "maniac_outro", None, 0),
    ("maniac_outro", "doctor_intro", None, 0),
    # Doctor
    ("doctor_intro", "doctor_action", None, 0),
    ("doctor_action", "doctor_outro", None, 0),
    ("doctor_outro", "night_resolve", None, 0),
    # Night resolve → winner check
    ("night_resolve", "night_winner_check", None, 0),
    (
        "night_winner_check",
        "mafia_won",
        {"type": "winner", "team": "mafia"},
        20,
    ),
    (
        "night_winner_check",
        "city_won",
        {"type": "winner", "team": "city"},
        20,
    ),
    (
        "night_winner_check",
        "maniac_won",
        {"type": "winner", "team": "maniac"},
        20,
    ),
    ("night_winner_check", "night_result", None, 0),
    # Day flow
    ("night_result", "day_discussion_intro", None, 0),
    ("day_discussion_intro", "day_discussion", None, 0),
    ("day_discussion", "day_voting_intro", None, 0),
    ("day_voting_intro", "day_voting", None, 0),
    ("day_voting", "day_resolve", None, 0),
    ("day_resolve", "day_winner_check", None, 0),
    (
        "day_winner_check",
        "mafia_won",
        {"type": "winner", "team": "mafia"},
        20,
    ),
    (
        "day_winner_check",
        "city_won",
        {"type": "winner", "team": "city"},
        20,
    ),
    (
        "day_winner_check",
        "maniac_won",
        {"type": "winner", "team": "maniac"},
        20,
    ),
    ("day_winner_check", "vote_result", None, 0),
    # Loop back to next night
    ("vote_result", "night_start_decision", None, 0),
    # Endings
    ("city_won", "end", None, 0),
    ("mafia_won", "end", None, 0),
    ("maniac_won", "end", None, 0),
]


_ENTRY_SLUG = "rules"


async def _resolve_trigger_ids(
    db: AsyncSession, slugs: set[str]
) -> dict[str, uuid.UUID]:
    """Возвращает dict slug→trigger_id для всех существующих триггеров."""
    rows = await db.scalars(
        select(NarratorTrigger).where(NarratorTrigger.slug.in_(slugs))
    )
    return {trig.slug: trig.id for trig in rows.all()}


async def ensure_classic_mafia_story(
    *, force_recreate: bool = False
) -> uuid.UUID | None:
    """Гарантирует наличие сюжета «Классическая Мафия» в БД.

    Идемпотентна: если уже есть запись со ``slug='classic_mafia', version=1`` —
    возвращает её id. Иначе создаёт всю структуру и возвращает id новой Story.

    ``force_recreate=True`` — удаляет существующий сюжет (вместе со всеми
    шагами/cues/transitions через CASCADE) и пересоздаёт. Опасная операция,
    используется только в тестах. **Не вызывать в lifespan startup.**

    Returns:
        UUID созданной/найденной Story, либо None если seed пропущен.
    """
    async with async_session_factory() as db:
        existing = await db.scalar(
            select(Story).where(
                Story.slug == CLASSIC_MAFIA_SLUG,
                Story.version == CLASSIC_MAFIA_VERSION,
            )
        )
        if existing is not None:
            if not force_recreate:
                return existing.id
            await db.delete(existing)
            await db.flush()

        # Соберём список всех trigger_slug'ов из cues для batch-резолва.
        all_slugs: set[str] = set()
        for step in _STEPS:
            for cue_def in step.get("cues", []):
                all_slugs.add(cue_def[0])
        trigger_id_by_slug = await _resolve_trigger_ids(db, all_slugs)

        missing_slugs = all_slugs - trigger_id_by_slug.keys()
        if missing_slugs:
            log_event(
                logger,
                logging.WARNING,
                "story_seed.missing_triggers",
                "Some narrator triggers are missing from DB; cues will be created text-only",
                missing_slugs=sorted(missing_slugs),
                hint="Run scripts/migrate_narrator_to_db.py or create triggers via /admin/narrator",
            )

        # 1. Story + Settings
        story = Story(
            id=uuid.uuid4(),
            slug=CLASSIC_MAFIA_SLUG,
            version=CLASSIC_MAFIA_VERSION,
            name="Классическая Мафия",
            description=(
                "Стандартный сценарий мафии: ночной цикл (любовница → мафия → дон → "
                "шериф → маньяк → доктор), дневная дискуссия, голосование. "
                "Поддержка веток по победителю."
            ),
            is_active=True,
            is_obsolete=False,
        )
        db.add(story)
        db.add(
            StorySettings(
                story_id=story.id,
                inter_cue_pause_seconds=0,
                timer_multiplier_default=1,
                karaoke_enabled=True,
            )
        )

        # 2. Steps. Сначала создаём все шаги без entry_step (циклика).
        step_id_by_slug: dict[str, uuid.UUID] = {}
        for step_def in _STEPS:
            step_id = uuid.uuid4()
            step_id_by_slug[step_def["slug"]] = step_id
            db.add(
                StoryStep(
                    id=step_id,
                    story_id=story.id,
                    slug=step_def["slug"],
                    kind=step_def["kind"],
                    label=step_def["label"],
                    payload=step_def.get("payload", {}),
                )
            )

        # Flush чтобы FK на step_id были валидны (для cues и transitions ниже).
        await db.flush()

        # 3. Cues для narration-шагов.
        for step_def in _STEPS:
            cues = step_def.get("cues", [])
            if not cues:
                continue
            step_id = step_id_by_slug[step_def["slug"]]
            for sort_order, cue_def in enumerate(cues):
                trigger_slug = cue_def[0]
                trigger_id = trigger_id_by_slug.get(trigger_slug)
                # Если триггер отсутствует — создаём text-only cue с fallback.
                override_text = (
                    None
                    if trigger_id is not None
                    else _TRIGGER_FALLBACK_TEXTS.get(trigger_slug, trigger_slug)
                )
                db.add(
                    StoryNarrationCue(
                        id=uuid.uuid4(),
                        step_id=step_id,
                        sort_order=sort_order,
                        trigger_id=trigger_id,
                        pause_before_ms=0,
                        pause_after_ms=0,
                        override_text=override_text,
                        override_duration_ms=None,
                    )
                )

        # 4. Transitions.
        for from_slug, to_slug, condition, priority in _TRANSITIONS:
            from_id = step_id_by_slug.get(from_slug)
            to_id = step_id_by_slug.get(to_slug)
            if from_id is None or to_id is None:
                # Это bug в _TRANSITIONS-таблице, не runtime-проблема.
                raise RuntimeError(
                    f"Story seed: transition refers to unknown step "
                    f"({from_slug!r} → {to_slug!r})"
                )
            db.add(
                StoryTransition(
                    id=uuid.uuid4(),
                    story_id=story.id,
                    from_step_id=from_id,
                    to_step_id=to_id,
                    condition=condition,
                    priority=priority,
                )
            )

        # 5. Entry step.
        entry_id = step_id_by_slug.get(_ENTRY_SLUG)
        if entry_id is None:
            raise RuntimeError(
                f"Story seed: entry step {_ENTRY_SLUG!r} не найден в _STEPS"
            )
        story.entry_step_id = entry_id

        await db.commit()

        log_event(
            logger,
            logging.INFO,
            "story_seed.created",
            "Classic Mafia story seeded",
            story_id=str(story.id),
            steps=len(_STEPS),
            transitions=len(_TRANSITIONS),
            cues_with_audio=sum(
                1
                for s in _STEPS
                for c in s.get("cues", [])
                if c[0] in trigger_id_by_slug
            ),
            cues_text_only=sum(
                1
                for s in _STEPS
                for c in s.get("cues", [])
                if c[0] not in trigger_id_by_slug
            ),
        )
        return story.id


if __name__ == "__main__":
    # Ручной запуск: python -m services.story_seed
    import asyncio

    asyncio.run(ensure_classic_mafia_story())
