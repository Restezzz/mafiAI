"""Хранилище mp3-файлов narrator-системы.

Отвечает за:
- Сохранение загруженных через UI mp3 в ``settings.AUDIO_STORAGE_ROOT/uploads/``.
- Извлечение duration_ms из mp3 через ``mutagen``.
- Удаление физического файла при удалении ``NarratorAudioFile``.

Storage layout:
- ``uploads/{uuid}.mp3`` — файлы, загруженные через админ-UI (Commit 7+).
- ``day/*.mp3``, ``night/*.mp3`` — изначально замигрированные из audio_manifest (Commit 5).
"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import BinaryIO

import mutagen
from mutagen import MutagenError
from mutagen.mp3 import MP3, HeaderNotFoundError

from core.config import settings
from core.exceptions import GameError


logger = logging.getLogger(__name__)


# Подкаталог в AUDIO_STORAGE_ROOT, куда складываются файлы, загруженные через UI.
UPLOADS_SUBDIR = "uploads"

# Чтение из multipart UploadFile — куски такого размера.
_CHUNK = 1024 * 1024  # 1 MB


def _uploads_dir() -> Path:
    p = settings.audio_storage_path / UPLOADS_SUBDIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def probe_duration_ms(file_path: Path) -> int:
    """Возвращает длительность аудио в миллисекундах.

    Поддерживает mp3, wav, ogg, flac, m4a и другие форматы, распознаваемые mutagen.

    Raises:
        GameError(400, 'invalid_mp3', ...) — если файл не является валидным аудио.
    """
    file_size = file_path.stat().st_size if file_path.exists() else 0
    try:
        # Сначала пробуем generic parser (поддерживает wav, ogg, flac, m4a, mp3)
        audio = mutagen.File(str(file_path))
        if audio is None:
            # mutagen не смог определить формат — пробуем как mp3 напрямую
            audio = MP3(str(file_path))
    except (HeaderNotFoundError, MutagenError) as exc:
        logger.warning(
            "audio.invalid_file path=%s size=%d error=%s",
            file_path, file_size, exc,
        )
        raise GameError(
            400, "invalid_mp3",
            f"Файл не является валидным аудио (size={file_size}, error={exc!r})",
        ) from exc
    duration_seconds = audio.info.length if audio.info else 0
    return int(round(duration_seconds * 1000))


async def save_uploaded_mp3(
    *,
    audio_id: uuid.UUID,
    source: BinaryIO,
) -> tuple[str, int, int]:
    """Сохраняет mp3 на диск под ``uploads/{audio_id}.mp3``.

    Args:
        audio_id: UUID будущей записи NarratorAudioFile (используется как имя файла,
            чтобы избежать конфликтов и path-traversal).
        source: file-like объект (UploadFile.file).

    Returns:
        Кортеж ``(storage_path, duration_ms, size_bytes)``. ``storage_path`` —
        относительный путь от AUDIO_STORAGE_ROOT (например ``uploads/abc...mp3``).

    Raises:
        GameError(400) — если содержимое не валидный mp3 (после полной записи).
    """
    rel_path = f"{UPLOADS_SUBDIR}/{audio_id}.mp3"
    full_path = settings.audio_storage_path / rel_path
    full_path.parent.mkdir(parents=True, exist_ok=True)

    size_bytes = 0
    with full_path.open("wb") as dst:
        while True:
            chunk = source.read(_CHUNK)
            if not chunk:
                break
            size_bytes += len(chunk)
            dst.write(chunk)

    if size_bytes == 0:
        full_path.unlink(missing_ok=True)
        raise GameError(400, "empty_upload", "Загруженный файл пуст")

    try:
        duration_ms = probe_duration_ms(full_path)
    except GameError:
        # Битый mp3 — подчищаем за собой.
        full_path.unlink(missing_ok=True)
        raise

    logger.info(
        "audio.uploaded path=%s size=%d duration_ms=%d", rel_path, size_bytes, duration_ms
    )
    return rel_path, duration_ms, size_bytes


def delete_storage_file(storage_path: str) -> bool:
    """Удаляет физический mp3-файл. Возвращает ``True``, если файл существовал и удалён.

    Никогда не выходит за пределы AUDIO_STORAGE_ROOT (защита от path-traversal):
    storage_path резолвится относительно AUDIO_STORAGE_ROOT и проверяется,
    что итоговый путь — внутри корня.
    """
    root = settings.audio_storage_path
    target = (root / storage_path).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        logger.error("audio.delete_blocked path_outside_root=%s", storage_path)
        return False
    if not target.is_file():
        logger.warning("audio.delete_missing path=%s", storage_path)
        return False
    target.unlink()
    logger.info("audio.deleted path=%s", storage_path)
    return True
