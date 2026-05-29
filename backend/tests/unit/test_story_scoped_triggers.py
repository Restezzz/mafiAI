"""Unit-тесты для story-scoped triggers (этап 6.6).

Покрывают:
1. Структура миграции 20260527_story_scoped_triggers — что
   она добавляет нужные колонки, FK и partial unique indexes
   (без них scope-aware namespace в админке развалится).
2. Сериализатор `_serialize_trigger` — что `story_id` корректно
   проходит в TriggerResponse как str/None в зависимости от
   scope триггера.
3. TriggerCreate — что `story_id` опционален (старые клиенты,
   создающие global trigger без явного передачи story_id, не ломаются).

Тесты не лезут в БД и не запускают alembic — это статические
проверки структуры (через AST + смок-вызовы чистых функций).
"""
from __future__ import annotations

import ast
import uuid
from pathlib import Path


# ---------------------------------------------------------------------------
# 1. Миграция: AST-проверка ключевых операций.
# ---------------------------------------------------------------------------


_MIGRATION_PATH = Path("alembic/versions/20260527_story_scoped_triggers.py")


def _migration_source() -> str:
    return _MIGRATION_PATH.read_text(encoding="utf-8")


def test_migration_revision_id_within_alembic_limit():
    """alembic_version.version_num имеет ограничение в 32 символа.

    Если revision id > 32, alembic upgrade упадёт с ProgrammingError на
    INSERT INTO alembic_version. Это тонкий баг — в dev-среде SQLite не
    всегда воспроизводится, а PostgreSQL в проде сразу падает.
    """
    tree = ast.parse(_migration_source())
    revision = None
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == "revision":
            if isinstance(node.value, ast.Constant):
                revision = node.value.value
                break
    assert revision is not None, "В миграции нет revision-id"
    assert len(revision) <= 32, f"revision id '{revision}' длиннее 32 символов"


def test_migration_adds_use_only_own_triggers_to_stories():
    src = _migration_source()
    assert "use_only_own_triggers" in src, (
        "Миграция должна добавлять колонку use_only_own_triggers в stories — "
        "иначе StorySettingsForm.toggle не сможет сохраниться."
    )
    assert '"stories"' in src and "add_column" in src
    # Должен быть default=false, иначе старые stories упадут на NOT NULL.
    assert "sa.false()" in src or "server_default" in src


def test_migration_adds_story_id_fk_to_narrator_triggers():
    src = _migration_source()
    assert "narrator_triggers" in src
    assert "story_id" in src
    assert "create_foreign_key" in src
    assert "ondelete=\"CASCADE\"" in src or "ondelete='CASCADE'" in src, (
        "FK story_id должен быть ON DELETE CASCADE — иначе при удалении "
        "сюжета упадёт constraint violation для всех его триггеров."
    )


def test_migration_creates_partial_unique_indexes():
    """Без partial unique индексов нельзя одновременно иметь global
    trigger со slug='foo' и story-scoped trigger со slug='foo' —
    что нужно для scope-aware namespace в админке.
    """
    src = _migration_source()
    assert "uq_narrator_triggers_global_slug" in src
    assert "uq_narrator_triggers_story_slug" in src
    # Partial условия (postgresql_where) — обязательны.
    assert "story_id IS NULL" in src
    assert "story_id IS NOT NULL" in src


def test_migration_drops_legacy_unique_slug_constraint():
    """Старый UNIQUE(slug) должен быть снят, иначе partial индексы
    не сработают и любые два scope не уживутся."""
    src = _migration_source()
    assert "narrator_triggers_slug_key" in src
    assert "drop_constraint" in src


def test_migration_has_downgrade():
    """Downgrade обязателен для возможности отката (Phase 6.6 → 6.5)."""
    tree = ast.parse(_migration_source())
    funcs = [n.name for n in tree.body if isinstance(n, ast.FunctionDef)]
    assert "upgrade" in funcs and "downgrade" in funcs


# ---------------------------------------------------------------------------
# 2. Сериализатор `_serialize_trigger` и list_triggers — AST-проверки.
#
# Прямой runtime-импорт `api.routers.admin_narrator` втягивает реальные
# зависимости (mutagen, jose, fastapi.File…), которые не нужны для проверки
# чистой структурной семантики сериализации. Используем AST-проверку — она
# показывает, что нужное поведение _физически написано_ в коде.
# ---------------------------------------------------------------------------


_ADMIN_NARRATOR_PATH = Path("api/routers/admin_narrator.py")


def _admin_narrator_source() -> str:
    return _ADMIN_NARRATOR_PATH.read_text(encoding="utf-8")


def test_serialize_trigger_includes_story_id_field():
    """Сериализатор должен передавать story_id в TriggerResponse.

    Без этой строчки фронт не сможет отличить global от story-scoped trigger,
    и UI-иконка 📁/🌐 в CueForm станет бессмысленной.
    """
    src = _admin_narrator_source()
    assert "_serialize_trigger" in src
    # Конкретно: `story_id=str(t.story_id) if t.story_id else None`
    assert "story_id=str(t.story_id) if t.story_id else None" in src, (
        "Сериализатор не передаёт story_id в TriggerResponse — фронт "
        "не сможет различать global и story-scoped триггеры."
    )


def test_list_triggers_supports_story_id_filter():
    """Список триггеров должен принимать ?story_id и ?include_global."""
    src = _admin_narrator_source()
    # Query-параметры в подписи list_triggers.
    assert "story_id: uuid.UUID | None" in src, (
        "list_triggers не принимает story_id — фильтрация по сюжету "
        "не будет работать (CueListEditor получит все триггеры)."
    )
    assert "include_global: bool" in src, (
        "list_triggers не принимает include_global — невозможно "
        "управлять видимостью global триггеров из конкретного сюжета."
    )
    # WHERE-условия для трёх сценариев.
    assert "NarratorTrigger.story_id == story_id" in src
    assert "NarratorTrigger.story_id.is_(None)" in src


def test_create_trigger_enforces_scope_aware_uniqueness():
    """create_trigger должен иметь scope-aware проверку slug-конфликта:
    global-slug проверяется в (story_id IS NULL), story-scoped —
    в (story_id == this story).
    """
    src = _admin_narrator_source()
    # Проверка по slug + scope (story_id IS NULL ИЛИ story_id == story_uuid).
    assert "trigger_slug_conflict" in src
    assert "NarratorTrigger.story_id.is_(None)" in src
    assert "NarratorTrigger.story_id == story_uuid" in src


def test_create_trigger_validates_story_exists():
    """Если story_id указан и сюжет не существует — должно вернуться
    404 story_not_found, а не FK-constraint violation на commit.
    """
    src = _admin_narrator_source()
    assert "story_not_found" in src
    assert "Story.id == story_uuid" in src


# ---------------------------------------------------------------------------
# 3. TriggerCreate schema — story_id опционален.
# ---------------------------------------------------------------------------


def test_trigger_create_story_id_defaults_to_none():
    """Старый payload без story_id → trigger создаётся как global.

    Без default=None в TriggerCreate.story_id старые клиенты упали бы
    с 422 Unprocessable Entity на отсутствующее поле.
    """
    from schemas.narrator import TriggerCreate

    payload = TriggerCreate(
        slug="legacy_intro",
        group_key="intro",
        label="Legacy",
        kind="variant",
    )

    assert payload.story_id is None


def test_trigger_create_accepts_story_id_string():
    """Story-scoped payload → story_id принимается как строка UUID
    (на API уровне далее будет конвертирован через uuid.UUID()).
    """
    from schemas.narrator import TriggerCreate

    sid = str(uuid.uuid4())
    payload = TriggerCreate(
        slug="scoped_intro",
        story_id=sid,
        group_key="intro",
        label="Scoped",
        kind="variant",
    )

    assert payload.story_id == sid
