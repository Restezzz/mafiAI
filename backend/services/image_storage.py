"""Хранилище загруженных картинок (аналог ``narrator_audio_storage``).

Отвечает за:
- Сохранение загруженных через UI картинок в ``settings.IMAGE_STORAGE_ROOT/uploads/``.
- Валидацию формата по magic-bytes (png/jpeg/webp/gif).
- Best-effort определение размеров (width/height) без тяжёлых зависимостей.
- Удаление физического файла.

Никаких сторонних зависимостей (Pillow) — детект формата/размеров делается
разбором заголовков. Неизвестный формат не валит загрузку, но размеры
останутся ``None``.
"""
from __future__ import annotations

import logging
import struct
import uuid
from pathlib import Path
from typing import BinaryIO

from core.config import settings
from core.exceptions import GameError


logger = logging.getLogger(__name__)

UPLOADS_SUBDIR = "uploads"
_CHUNK = 1024 * 1024  # 1 MB
_MAX_BYTES = 10 * 1024 * 1024  # 10 MB — потолок для картинки.

# magic-байты → (расширение)
_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def _detect_format(head: bytes) -> str | None:
    for sig, ext in _SIGNATURES:
        if head.startswith(sig):
            return ext
    # WebP: 'RIFF'....'WEBP'
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _probe_dimensions(data: bytes, fmt: str) -> tuple[int | None, int | None]:
    """Best-effort извлечение (width, height) из заголовка картинки."""
    try:
        if fmt == "png" and len(data) >= 24:
            w, h = struct.unpack(">II", data[16:24])
            return int(w), int(h)
        if fmt == "gif" and len(data) >= 10:
            w, h = struct.unpack("<HH", data[6:10])
            return int(w), int(h)
        if fmt == "jpg":
            return _jpeg_dimensions(data)
        if fmt == "webp":
            return _webp_dimensions(data)
    except Exception:  # noqa: BLE001 — размеры не критичны, не валим загрузку
        logger.warning("image.dimension_probe_failed fmt=%s", fmt)
    return None, None


def _jpeg_dimensions(data: bytes) -> tuple[int | None, int | None]:
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        # SOF-маркеры с размерами кадра.
        if marker in (
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        ):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return int(w), int(h)
        seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
        i += 2 + seg_len
    return None, None


def _webp_dimensions(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 30:
        return None, None
    fourcc = data[12:16]
    if fourcc == b"VP8 ":
        w = struct.unpack("<H", data[26:28])[0] & 0x3FFF
        h = struct.unpack("<H", data[28:30])[0] & 0x3FFF
        return int(w), int(h)
    if fourcc == b"VP8L":
        b = data[21:25]
        bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)
        w = (bits & 0x3FFF) + 1
        h = ((bits >> 14) & 0x3FFF) + 1
        return int(w), int(h)
    if fourcc == b"VP8X":
        w = 1 + (data[24] | (data[25] << 8) | (data[26] << 16))
        h = 1 + (data[27] | (data[28] << 8) | (data[29] << 16))
        return int(w), int(h)
    return None, None


async def save_uploaded_image(
    *,
    image_id: uuid.UUID,
    source: BinaryIO,
) -> tuple[str, int, int | None, int | None]:
    """Сохраняет картинку на диск под ``uploads/{image_id}.{ext}``.

    Returns:
        ``(storage_path, size_bytes, width, height)``. ``storage_path`` —
        относительный путь от IMAGE_STORAGE_ROOT.

    Raises:
        GameError(400) — пустой файл / слишком большой / неподдерживаемый формат.
    """
    data = bytearray()
    while True:
        chunk = source.read(_CHUNK)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > _MAX_BYTES:
            raise GameError(400, "image_too_large", "Картинка больше 10 МБ")

    if not data:
        raise GameError(400, "empty_upload", "Загруженный файл пуст")

    fmt = _detect_format(bytes(data[:16]))
    if fmt is None:
        raise GameError(
            400, "invalid_image", "Неподдерживаемый формат (png/jpg/gif/webp)"
        )

    width, height = _probe_dimensions(bytes(data), fmt)

    rel_path = f"{UPLOADS_SUBDIR}/{image_id}.{fmt}"
    full_path = settings.image_storage_path / rel_path
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_bytes(bytes(data))

    logger.info(
        "image.uploaded path=%s size=%d dims=%sx%s",
        rel_path, len(data), width, height,
    )
    return rel_path, len(data), width, height


def delete_storage_file(storage_path: str) -> bool:
    """Удаляет физический файл картинки. Защита от path-traversal."""
    root = settings.image_storage_path
    target = (root / storage_path).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        logger.error("image.delete_blocked path_outside_root=%s", storage_path)
        return False
    if not target.is_file():
        logger.warning("image.delete_missing path=%s", storage_path)
        return False
    target.unlink()
    logger.info("image.deleted path=%s", storage_path)
    return True
