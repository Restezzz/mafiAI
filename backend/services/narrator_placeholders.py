"""Каталог placeholder'ов для composite-фраз narrator-системы.

Этот каталог — single source of truth для:
- админ-панели (выпадающий список при создании composite-segment kind='placeholder');
- runtime-резолвера в ``narrator_repo`` (commit 7), который при сборке
  audio_segments подставляет реальное значение из ``ctx`` (player_name из
  Player.display_name, role из Player.role.name, и т.п.).

Добавление нового placeholder'а требует:
1. Добавить запись сюда.
2. Расширить резолвер в ``narrator_repo`` (узнать откуда брать значение).
3. В game_engine — передавать соответствующее поле в ctx при вызове
   ``narrator_repo.build_steps(slug, seed_key, ctx)``.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PlaceholderSpec:
    key: str
    label: str
    description: str


# Доступные placeholder'ы.
# key должен совпадать со значением column narrator_composite_segments.placeholder_key
# и с ключом в ctx при вызове резолвера.
PLACEHOLDER_CATALOG: tuple[PlaceholderSpec, ...] = (
    PlaceholderSpec(
        key="player_name",
        label="Имя игрока",
        description="Имя игрока в контексте текущей фразы (например, на которого пал выбор мафии).",
    ),
    PlaceholderSpec(
        key="eliminated_name",
        label="Имя выбывшего",
        description="Имя игрока, который только что был убит ночью или изгнан голосованием.",
    ),
    PlaceholderSpec(
        key="eliminated_role",
        label="Роль выбывшего",
        description="Название роли выбывшего игрока (используется при раскрытии после голосования).",
    ),
    PlaceholderSpec(
        key="accused_name",
        label="Имя обвиняемого",
        description="Игрок, выставленный на голосование.",
    ),
    PlaceholderSpec(
        key="saved_player_name",
        label="Имя спасённого",
        description="Игрок, которого ночью спас доктор (используется в multiple_killed_with_save / one_killed_with_save).",
    ),
    PlaceholderSpec(
        key="died_player_name",
        label="Имя погибшего",
        description="Имя одного погибшего ночью игрока (single victim).",
    ),
    PlaceholderSpec(
        key="died_player_names",
        label="Имена погибших",
        description="Список погибших ночью игроков, объединённых через ' и ' (multi-victim).",
    ),
    PlaceholderSpec(
        key="blocked_player_name",
        label="Имя заблокированного",
        description="Игрок, которого любовница ночью заблокировала на дневное голосование.",
    ),
)


def get_placeholder_catalog() -> tuple[PlaceholderSpec, ...]:
    return PLACEHOLDER_CATALOG


def is_known_placeholder(key: str) -> bool:
    return any(p.key == key for p in PLACEHOLDER_CATALOG)
