"""Slugify-хелпер для narrator-системы.

Используется при создании ``NarratorNameAsset`` (slug автогенерируется из
``display_name``), а также для валидации совместимости со старым форматом
audio_manifest.json (см. scripts/build_audio_manifest.py — там та же логика).

Поддерживает кириллицу через транслитерацию + латиницу/цифры. Пробелы и
дефисы превращаются в подчёркивания, регистры приводятся к нижнему,
многократные подчёркивания схлопываются.
"""
from __future__ import annotations

import re


# Дублируется со ``scripts/build_audio_manifest.py``. Если меняешь — синхронизируй
# обе таблицы, иначе slug'и существующих имён разъедутся.
_TRANSLIT: dict[str, str] = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "",
    "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify_display_name(text: str) -> str:
    """Транслит + lowercase + [a-z0-9_] only. Возвращает '' если ничего не осталось."""
    text = text.lower().strip()
    out: list[str] = []
    for ch in text:
        if ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        elif ch.isalnum() and ord(ch) < 128:
            # ASCII letters/digits only — отсекаем европейский диакритик и пр.
            out.append(ch)
        elif ch in (" ", "_", "-"):
            out.append("_")
    s = "".join(out)
    s = re.sub(r"_+", "_", s).strip("_")
    return s
