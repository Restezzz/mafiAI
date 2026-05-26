"""Юнит-тесты для ``services.story_runtime._evaluate_condition``.

Покрывают все 8 атомарных типов условий + рекурсивные all/any/not.
Не требуют БД — функция чистая (dict + dict → bool).
"""
from __future__ import annotations

from typing import Any

import pytest

from services.story_runtime import _evaluate_condition


# ============================================================================
# Безусловные / fallback
# ============================================================================


def test_none_condition_returns_true() -> None:
    """Безусловный transition (condition=None) всегда матчится."""
    assert _evaluate_condition(None, {}) is True


def test_unknown_type_returns_false() -> None:
    """Неизвестный тип — False, чтобы tipo'вый transition не срабатывал."""
    assert _evaluate_condition({"type": "alien_predicate"}, {}) is False


def test_missing_type_returns_false() -> None:
    assert _evaluate_condition({}, {}) is False


# ============================================================================
# winner
# ============================================================================


@pytest.mark.parametrize(
    "team,winner_team,expected",
    [
        ("city", "city", True),
        ("city", "mafia", False),
        ("mafia", "mafia", True),
        ("maniac", "maniac", True),
        ("city", None, False),
    ],
)
def test_winner_team_match(team: str, winner_team: Any, expected: bool) -> None:
    cond = {"type": "winner", "team": team}
    assert _evaluate_condition(cond, {"winner_team": winner_team}) is expected


def test_winner_null_team_matches_any_winner() -> None:
    """{type: winner, team: null} матчится при любом установленном winner_team."""
    cond = {"type": "winner", "team": None}
    assert _evaluate_condition(cond, {"winner_team": "city"}) is True
    assert _evaluate_condition(cond, {"winner_team": "mafia"}) is True
    assert _evaluate_condition(cond, {"winner_team": None}) is False
    assert _evaluate_condition(cond, {}) is False


# ============================================================================
# phase_number
# ============================================================================


@pytest.mark.parametrize(
    "op,value,actual,expected",
    [
        ("==", 1, 1, True),
        ("==", 1, 2, False),
        ("!=", 1, 2, True),
        (">=", 2, 3, True),
        (">=", 2, 2, True),
        (">=", 2, 1, False),
        ("<=", 2, 1, True),
        ("<=", 2, 2, True),
        ("<=", 2, 3, False),
        (">", 2, 3, True),
        (">", 2, 2, False),
        ("<", 2, 1, True),
        ("<", 2, 2, False),
    ],
)
def test_phase_number_comparisons(op: str, value: int, actual: int, expected: bool) -> None:
    cond = {"type": "phase_number", "op": op, "value": value}
    assert _evaluate_condition(cond, {"phase_number": actual}) is expected


def test_phase_number_default_is_zero() -> None:
    """Если phase_number не задан в step_vars — считаем 0."""
    cond = {"type": "phase_number", "op": "==", "value": 0}
    assert _evaluate_condition(cond, {}) is True


def test_phase_number_invalid_op_returns_false() -> None:
    cond = {"type": "phase_number", "op": None, "value": 1}
    assert _evaluate_condition(cond, {"phase_number": 1}) is False


# ============================================================================
# vote_tie
# ============================================================================


def test_vote_tie_truthy() -> None:
    assert _evaluate_condition({"type": "vote_tie"}, {"vote_tie": True}) is True


def test_vote_tie_falsy() -> None:
    assert _evaluate_condition({"type": "vote_tie"}, {"vote_tie": False}) is False
    assert _evaluate_condition({"type": "vote_tie"}, {}) is False


# ============================================================================
# died_role / death_cause
# ============================================================================


def test_died_role_match() -> None:
    cond = {"type": "died_role", "role_slug": "sheriff"}
    assert _evaluate_condition(cond, {"died_role": "sheriff"}) is True
    assert _evaluate_condition(cond, {"died_role": "mafia"}) is False
    assert _evaluate_condition(cond, {}) is False


def test_death_cause_match() -> None:
    cond = {"type": "death_cause", "value": "vote"}
    assert _evaluate_condition(cond, {"death_cause": "vote"}) is True
    assert _evaluate_condition(cond, {"death_cause": "night"}) is False


# ============================================================================
# role_alive / role_dead
# ============================================================================


def test_role_alive_match() -> None:
    cond = {"type": "role_alive", "role_slug": "sheriff"}
    assert _evaluate_condition(cond, {"alive_roles": ["mafia", "sheriff"]}) is True
    assert _evaluate_condition(cond, {"alive_roles": ["mafia"]}) is False
    assert _evaluate_condition(cond, {}) is False


def test_role_dead_match() -> None:
    cond = {"type": "role_dead", "role_slug": "sheriff"}
    assert _evaluate_condition(cond, {"alive_roles": ["mafia"]}) is True
    assert _evaluate_condition(cond, {"alive_roles": ["mafia", "sheriff"]}) is False
    # Если alive_roles не задан — сериф «не жив» по умолчанию = True.
    # Такое поведение допустимо для фолбэка, но в проде step_vars всегда
    # должны иметь alive_roles после night_resolve / day_resolve.
    assert _evaluate_condition(cond, {}) is True


# ============================================================================
# step_var (универсальное)
# ============================================================================


def test_step_var_eq_string() -> None:
    cond = {"type": "step_var", "key": "winner_team", "op": "==", "value": "city"}
    assert _evaluate_condition(cond, {"winner_team": "city"}) is True
    assert _evaluate_condition(cond, {"winner_team": "mafia"}) is False


def test_step_var_numeric_comparison() -> None:
    cond = {"type": "step_var", "key": "kills", "op": ">=", "value": 2}
    assert _evaluate_condition(cond, {"kills": 3}) is True
    assert _evaluate_condition(cond, {"kills": 2}) is True
    assert _evaluate_condition(cond, {"kills": 1}) is False


def test_step_var_incomparable_types_returns_false() -> None:
    """str vs int — несравнимо в py3 (TypeError) → False."""
    cond = {"type": "step_var", "key": "k", "op": ">", "value": 5}
    assert _evaluate_condition(cond, {"k": "string"}) is False


def test_step_var_missing_key() -> None:
    cond = {"type": "step_var", "key": "missing", "op": "==", "value": None}
    assert _evaluate_condition(cond, {}) is True  # None == None
    cond_neq = {"type": "step_var", "key": "missing", "op": "!=", "value": None}
    assert _evaluate_condition(cond_neq, {}) is False


# ============================================================================
# Композитные: all / any / not
# ============================================================================


def test_all_empty_is_true() -> None:
    """all([]) = True по математической конвенции (vacuous truth)."""
    assert _evaluate_condition({"type": "all", "conditions": []}, {}) is True


def test_all_single_true() -> None:
    cond = {
        "type": "all",
        "conditions": [{"type": "vote_tie"}],
    }
    assert _evaluate_condition(cond, {"vote_tie": True}) is True
    assert _evaluate_condition(cond, {"vote_tie": False}) is False


def test_all_short_circuits_on_first_false() -> None:
    cond = {
        "type": "all",
        "conditions": [
            {"type": "phase_number", "op": "==", "value": 1},
            {"type": "winner", "team": "city"},
        ],
    }
    assert (
        _evaluate_condition(cond, {"phase_number": 1, "winner_team": "city"}) is True
    )
    assert (
        _evaluate_condition(cond, {"phase_number": 2, "winner_team": "city"}) is False
    )
    assert (
        _evaluate_condition(cond, {"phase_number": 1, "winner_team": "mafia"}) is False
    )


def test_any_empty_is_false() -> None:
    """any([]) = False по математической конвенции (vacuous falsity)."""
    assert _evaluate_condition({"type": "any", "conditions": []}, {}) is False


def test_any_short_circuits_on_first_true() -> None:
    cond = {
        "type": "any",
        "conditions": [
            {"type": "winner", "team": "city"},
            {"type": "winner", "team": "mafia"},
        ],
    }
    assert _evaluate_condition(cond, {"winner_team": "city"}) is True
    assert _evaluate_condition(cond, {"winner_team": "mafia"}) is True
    assert _evaluate_condition(cond, {"winner_team": "maniac"}) is False
    assert _evaluate_condition(cond, {}) is False


def test_not_inverts() -> None:
    cond = {"type": "not", "condition": {"type": "vote_tie"}}
    assert _evaluate_condition(cond, {"vote_tie": True}) is False
    assert _evaluate_condition(cond, {"vote_tie": False}) is True


def test_nested_recursive_combinator() -> None:
    """all(any(A, not B), C) — сложная комбинация."""
    cond = {
        "type": "all",
        "conditions": [
            {
                "type": "any",
                "conditions": [
                    {"type": "winner", "team": "city"},
                    {"type": "not", "condition": {"type": "vote_tie"}},
                ],
            },
            {"type": "phase_number", "op": ">=", "value": 2},
        ],
    }
    # winner=city, vote_tie=any, phase=2 → all(any(T, ?), T) = T
    assert _evaluate_condition(
        cond, {"winner_team": "city", "vote_tie": True, "phase_number": 2}
    ) is True
    # winner=mafia, vote_tie=False (→ not False = True), phase=2 → all(any(F, T), T) = T
    assert _evaluate_condition(
        cond, {"winner_team": "mafia", "vote_tie": False, "phase_number": 2}
    ) is True
    # winner=mafia, vote_tie=True (→ not True = False), phase=2 → all(any(F, F), T) = F
    assert _evaluate_condition(
        cond, {"winner_team": "mafia", "vote_tie": True, "phase_number": 2}
    ) is False
    # winner=city, phase=1 → all(any(T, ?), F) = F
    assert _evaluate_condition(
        cond, {"winner_team": "city", "phase_number": 1}
    ) is False
