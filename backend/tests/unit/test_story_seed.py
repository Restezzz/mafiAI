"""Статическая валидация данных Story Engine seed.

Эти тесты не запускают БД, они проверяют ``_STEPS``, ``_TRANSITIONS``,
``_ENTRY_SLUG`` и ``_TRIGGER_FALLBACK_TEXTS`` из ``services/story_seed.py``
на самосогласованность:

- Уникальные step-slug'и.
- Все transitions ссылаются на существующие step-slug'и.
- entry_slug существует.
- Все step.kind ∈ STORY_STEP_KINDS.
- role_action-шаги ссылаются на существующие роли (ROLE_CATALOG).
- Граф связан: BFS от entry достигает все шаги.
- Все trigger_slug в cues имеют fallback_text (для случаев когда триггера
  ещё нет в narrator_triggers).
- branch / end / narration / role_action — структурные проверки.

Идемпотентность ``ensure_classic_mafia_story`` тестируется отдельно в
integration (требует БД и async_session_factory).
"""
from __future__ import annotations

import ast
from collections import deque
from pathlib import Path

import pytest

from models.story import STORY_STEP_KINDS
from services import story_seed
from services.role_catalog import ROLE_CATALOG


# ============================================================================
# Helpers
# ============================================================================


def _slugs_set() -> set[str]:
    return {s["slug"] for s in story_seed._STEPS}


def _step_by_slug(slug: str) -> dict:
    for s in story_seed._STEPS:
        if s["slug"] == slug:
            return s
    raise KeyError(slug)


# ============================================================================
# Step-уровневые инварианты
# ============================================================================


def test_steps_have_unique_slugs() -> None:
    slugs = [s["slug"] for s in story_seed._STEPS]
    duplicates = {x for x in slugs if slugs.count(x) > 1}
    assert not duplicates, f"Найдены дубликаты step.slug: {duplicates}"


def test_step_kinds_are_valid() -> None:
    for s in story_seed._STEPS:
        assert s["kind"] in STORY_STEP_KINDS, (
            f"Step {s['slug']!r}: kind={s['kind']!r} не в STORY_STEP_KINDS"
        )


def test_step_slugs_match_pattern() -> None:
    """Slug должен быть [a-z0-9_]{1,80} — соответствует CHECK constraint в БД."""
    import re
    pattern = re.compile(r"^[a-z0-9_]{1,80}$")
    for s in story_seed._STEPS:
        assert pattern.match(s["slug"]), (
            f"Step.slug={s['slug']!r} не соответствует [a-z0-9_]{{1,80}}"
        )


def test_role_action_steps_reference_valid_roles() -> None:
    """Каждый role_action-шаг должен указывать payload.role_slug на роль из ROLE_CATALOG."""
    role_slugs = {r["slug"] for r in ROLE_CATALOG}
    for s in story_seed._STEPS:
        if s["kind"] != "role_action":
            continue
        payload = s.get("payload", {})
        role_slug = payload.get("role_slug")
        assert role_slug is not None, (
            f"role_action step {s['slug']!r} не имеет payload.role_slug"
        )
        assert role_slug in role_slugs, (
            f"role_action step {s['slug']!r}: role_slug={role_slug!r} "
            f"не найден в ROLE_CATALOG (доступные: {sorted(role_slugs)})"
        )


def test_narration_steps_have_at_least_one_cue() -> None:
    """Narration без cues = бессмысленный шаг (нечего проигрывать)."""
    for s in story_seed._STEPS:
        if s["kind"] != "narration":
            continue
        cues = s.get("cues", [])
        assert cues, f"narration step {s['slug']!r} не имеет ни одного cue"


def test_non_narration_steps_have_no_cues() -> None:
    """Cues привязываются ТОЛЬКО к narration-шагам (см. constraint в БД)."""
    for s in story_seed._STEPS:
        if s["kind"] == "narration":
            continue
        cues = s.get("cues", [])
        assert not cues, (
            f"step {s['slug']!r} kind={s['kind']!r} не должен иметь cues, "
            f"но имеет {len(cues)}"
        )


# ============================================================================
# Transitions
# ============================================================================


def test_transitions_reference_valid_step_slugs() -> None:
    valid = _slugs_set()
    for from_slug, to_slug, _cond, _prio in story_seed._TRANSITIONS:
        assert from_slug in valid, (
            f"transition {from_slug!r} → {to_slug!r}: from_slug не существует"
        )
        assert to_slug in valid, (
            f"transition {from_slug!r} → {to_slug!r}: to_slug не существует"
        )


def test_transitions_have_no_self_loops() -> None:
    for from_slug, to_slug, _cond, _prio in story_seed._TRANSITIONS:
        assert from_slug != to_slug, f"Self-loop: {from_slug!r} → {to_slug!r}"


def test_transitions_priority_is_non_negative() -> None:
    for from_slug, to_slug, _cond, prio in story_seed._TRANSITIONS:
        assert 0 <= prio <= 1000, (
            f"transition {from_slug!r} → {to_slug!r}: priority={prio} вне [0, 1000]"
        )


def test_branch_steps_have_outgoing_transitions() -> None:
    """branch-step без исходящих рёбер = тупик. Должно быть ≥ 2 ребра
    (хотя бы один с условием + один безусловный fallback)."""
    out_count: dict[str, int] = {}
    for from_slug, _to, _cond, _prio in story_seed._TRANSITIONS:
        out_count[from_slug] = out_count.get(from_slug, 0) + 1

    for s in story_seed._STEPS:
        if s["kind"] != "branch":
            continue
        n = out_count.get(s["slug"], 0)
        assert n >= 2, (
            f"branch step {s['slug']!r} имеет {n} исходящих рёбер; "
            f"должно быть ≥2 (условные + fallback)"
        )


def test_branch_steps_have_unconditional_fallback() -> None:
    """У каждого branch должен быть хотя бы один безусловный edge — иначе
    при невыполнении всех условий граф упадёт в тупик."""
    branch_slugs = {s["slug"] for s in story_seed._STEPS if s["kind"] == "branch"}
    has_uncond: set[str] = set()
    for from_slug, _to, cond, _prio in story_seed._TRANSITIONS:
        if from_slug in branch_slugs and cond is None:
            has_uncond.add(from_slug)
    missing = branch_slugs - has_uncond
    assert not missing, (
        f"branch-шаги без безусловного fallback: {sorted(missing)} — "
        f"при невыполнении всех условий граф зависнет"
    )


def test_end_steps_have_no_outgoing_transitions() -> None:
    """end-step — терминальный, не должно быть исходящих рёбер."""
    end_slugs = {s["slug"] for s in story_seed._STEPS if s["kind"] == "end"}
    for from_slug, to_slug, _cond, _prio in story_seed._TRANSITIONS:
        assert from_slug not in end_slugs, (
            f"end step {from_slug!r} имеет исходящий edge → {to_slug!r}"
        )


def test_end_steps_are_reached_from_endings() -> None:
    """Должен существовать end-step, и хотя бы один edge ведёт к нему."""
    end_slugs = {s["slug"] for s in story_seed._STEPS if s["kind"] == "end"}
    assert end_slugs, "В графе нет ни одного end-step"

    incoming_to_end: set[str] = set()
    for _from, to_slug, _cond, _prio in story_seed._TRANSITIONS:
        if to_slug in end_slugs:
            incoming_to_end.add(to_slug)
    assert incoming_to_end, "Ни один edge не ведёт к end-step"


# ============================================================================
# Entry & connectivity
# ============================================================================


def test_entry_slug_exists() -> None:
    assert story_seed._ENTRY_SLUG in _slugs_set(), (
        f"_ENTRY_SLUG={story_seed._ENTRY_SLUG!r} не найден в _STEPS"
    )


def test_graph_is_fully_reachable_from_entry() -> None:
    """BFS от entry должен достичь всех шагов. Недостижимый шаг = мёртвый код."""
    adj: dict[str, list[str]] = {s["slug"]: [] for s in story_seed._STEPS}
    for from_slug, to_slug, _cond, _prio in story_seed._TRANSITIONS:
        adj[from_slug].append(to_slug)

    reachable: set[str] = set()
    queue: deque[str] = deque([story_seed._ENTRY_SLUG])
    while queue:
        cur = queue.popleft()
        if cur in reachable:
            continue
        reachable.add(cur)
        queue.extend(adj.get(cur, []))

    all_slugs = _slugs_set()
    unreachable = all_slugs - reachable
    assert not unreachable, (
        f"Недостижимые от entry={story_seed._ENTRY_SLUG!r} шаги: {sorted(unreachable)}"
    )


def test_every_non_terminal_step_has_outgoing_edge() -> None:
    """Любой шаг кроме end должен иметь исходящее ребро, иначе тупик."""
    has_out: set[str] = {from_slug for from_slug, *_ in story_seed._TRANSITIONS}
    for s in story_seed._STEPS:
        if s["kind"] == "end":
            continue
        assert s["slug"] in has_out, (
            f"Step {s['slug']!r} (kind={s['kind']!r}) не имеет исходящих рёбер — тупик"
        )


# ============================================================================
# Triggers / fallback texts
# ============================================================================


def test_all_cue_triggers_have_fallback_text() -> None:
    """Если в БД отсутствует NarratorTrigger — seed создаст cue с fallback-текстом.
    Все trigger_slug в _STEPS.cues должны быть представлены в _TRIGGER_FALLBACK_TEXTS."""
    used_slugs: set[str] = set()
    for s in story_seed._STEPS:
        for cue in s.get("cues", []):
            used_slugs.add(cue[0])

    missing = used_slugs - story_seed._TRIGGER_FALLBACK_TEXTS.keys()
    assert not missing, (
        f"trigger_slug используются в _STEPS.cues, но нет fallback-текста: "
        f"{sorted(missing)}"
    )


def test_no_unused_fallback_texts() -> None:
    """Гигиена: fallback-текст для триггера, который нигде не используется,
    — это мёртвый код. Если убрали cue — убирайте и fallback."""
    used_slugs: set[str] = set()
    for s in story_seed._STEPS:
        for cue in s.get("cues", []):
            used_slugs.add(cue[0])

    unused = story_seed._TRIGGER_FALLBACK_TEXTS.keys() - used_slugs
    assert not unused, (
        f"_TRIGGER_FALLBACK_TEXTS содержит неиспользуемые ключи: {sorted(unused)}"
    )


# ============================================================================
# Migration
# ============================================================================


def test_story_engine_tables_migration_present() -> None:
    """Файл миграции существует и имеет валидный revision id."""
    path = Path("alembic/versions/20260526_story_engine_tables.py")
    assert path.exists(), f"Миграция {path} отсутствует"

    tree = ast.parse(path.read_text(encoding="utf-8"))
    revision = None
    down_revision = None
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == "revision":
            if isinstance(node.value, ast.Constant):
                revision = node.value.value
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == "down_revision":
            if isinstance(node.value, ast.Constant):
                down_revision = node.value.value

    assert revision is not None, "У миграции нет revision id"
    assert len(revision) <= 32, "revision id слишком длинный для alembic_version (varchar(32))"
    # down_revision должен быть установлен (не None) — иначе это начальная миграция,
    # что ломает linear-history.
    assert down_revision is not None, (
        "down_revision миграции story_engine_tables не должен быть None"
    )


# ============================================================================
# Sanity
# ============================================================================


@pytest.mark.parametrize(
    "expected_slug",
    [
        "rules",
        "intro_personality",
        "night_start_decision",
        "lover_action",
        "mafia_action",
        "don_action",
        "sheriff_action",
        "maniac_action",
        "doctor_action",
        "night_resolve",
        "day_voting",
        "day_resolve",
        "city_won",
        "mafia_won",
        "maniac_won",
        "end",
    ],
)
def test_critical_classic_mafia_steps_present(expected_slug: str) -> None:
    """Регрессия: эти ключевые шаги классической мафии должны всегда быть
    в seed. Изменение _STEPS — осознанный break, тест поможет вспомнить."""
    assert expected_slug in _slugs_set(), (
        f"Критичный для классической мафии step {expected_slug!r} удалён из seed"
    )
