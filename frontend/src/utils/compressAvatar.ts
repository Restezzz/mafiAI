/**
 * Сжимает картинку до квадратной аватарки фиксированного размера в JPEG.
 *
 * Используем canvas вместо отправки сырого файла — это позволяет:
 *  - привести к стандартному размеру (256×256), независимо от исходного;
 *  - снизить размер data URL до ~30-50КБ даже из 10МБ-фото;
 *  - оборвать EXIF и прочие метаданные (privacy).
 *
 * Возвращает data:image/jpeg;base64,...
 */
export async function compressAvatar(
  file: File,
  options: { size?: number; quality?: number } = {},
): Promise<string> {
  const targetSize = options.size ?? 256;
  const quality = options.quality ?? 0.85;

  const bitmap = await loadImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context not available');
    }

    // Центрированный crop к квадрату, затем resize до targetSize.
    const minSide = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - minSide) / 2;
    const sy = (bitmap.height - minSide) / 2;
    ctx.drawImage(bitmap, sx, sy, minSide, minSide, 0, 0, targetSize, targetSize);

    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    if ('close' in bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }
}

async function loadImageBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap быстрее и не требует DOM — но не во всех старых браузерах.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // fallthrough на HTMLImageElement
    }
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}
