from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class SessionRuntime:
    # day subphase: "discussion" | "voting" | None
    day_sub_phase: str | None = None

    # night turn: "lover" | "mafia" | "don" | "sheriff" | "doctor" | "maniac" | None
    night_turn: str | None = None

    # current timer metadata for state endpoint
    timer_name: str | None = None
    timer_seconds: int | None = None
    timer_started_at: datetime | None = None

    # events to unblock waiting in night sequence
    night_action_event: asyncio.Event = field(default_factory=asyncio.Event)

    # mafia: first choice wins (store target player_id)
    mafia_choice_target: uuid.UUID | None = None
    mafia_choice_by: uuid.UUID | None = None  # actor_player_id

    # maniac: отдельный от мафии убийца, работает параллельно
    maniac_choice_target: uuid.UUID | None = None

    # доктор: ограничения на цели
    doctor_last_heal: uuid.UUID | None = None  # последняя успешно вылеченная цель
    doctor_self_heals: int = 0  # сколько раз доктор лечил себя (лимит 1 за игру)

    # любовница: цель последней ночи и игроки, заблокированные этой ночью
    lover_last_target: uuid.UUID | None = None
    blocked_tonight: set[uuid.UUID] = field(default_factory=set)

    # кого заблокировала любовница прошлой ночью — игрок не может голосовать днём.
    # Сбрасывается после перехода в следующую ночь.
    day_blocked_player: uuid.UUID | None = None

    # background task marker (чтобы не запускать несколько recovery/sequence параллельно)
    night_sequence_running: bool = False

    # Story Engine: True пока _run_loop активен. recovery_loop проверяет
    # этот флаг чтобы не запустить вторую копию executor параллельно.
    # Сбрасывается в False в finally-блоке _run_loop.
    story_engine_running: bool = False

    # Переход между фазами / резолв фаз выполняется прямо сейчас.
    # Recovery не должен вмешиваться, пока этот флаг поднят.
    phase_transition_running: bool = False
    phase_transition_depth: int = 0

    # пауза: таймеры остановлены, ночная последовательность ждёт снятия паузы
    game_paused: bool = False

    # События для прерываемого ожидания в _wait_or_pause:
    # - pause_event: set когда game_paused=True (прерывает текущий sleep в фазе)
    # - resume_event: set когда game_paused=False (разрешает продолжить sleep)
    # Раньше _wait_or_pause polling'ил флаг каждые 200ms; теперь wait_for(...) спит
    # до конца таймаута без расхода CPU и просыпается мгновенно при изменении паузы.
    pause_event: asyncio.Event = field(default_factory=asyncio.Event)
    resume_event: asyncio.Event = field(default_factory=asyncio.Event)

    # прервать ночную последовательность (кик / срочный выход из ожидания хода)
    night_sequence_abort: bool = False

    # Текущий блокирующий шаг ведущего для reconnect-safe /state.
    current_announcement: dict[str, Any] | None = None
    announcement_started_at: datetime | None = None

    # Раунд дневного голосования и список кандидатов для переголосования.
    vote_round: int = 1
    voting_candidate_ids: list[uuid.UUID] | None = None

    def __post_init__(self) -> None:
        # Изначально игра НЕ на паузе, поэтому resume_event = set.
        self.resume_event.set()


class RuntimeState:
    def __init__(self):
        self._sessions: dict[uuid.UUID, SessionRuntime] = {}

    def get(self, session_id: uuid.UUID) -> SessionRuntime:
        return self._sessions.setdefault(session_id, SessionRuntime())

    def clear(self, session_id: uuid.UUID) -> None:
        self._sessions.pop(session_id, None)


runtime_state = RuntimeState()
