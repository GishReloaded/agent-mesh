import { AVATAR_MAX_BYTES } from '@agentmesh/sdk';

/**
 * Prepare a picture for use as an avatar.
 *
 * Two problems this solves, both of which show up as "the quality got worse
 * after uploading".
 *
 * A browser asked to paint a 900-pixel photograph into a 28-pixel tile does the
 * whole reduction in one step while drawing, and on anything with fine detail
 * that aliases badly. Reducing once, deliberately, with the canvas smoothing
 * turned up, produces a far cleaner result - and it is done once at upload
 * rather than on every render, in every client.
 *
 * The other is shape: a portrait photograph placed in a square tile has its
 * sides cropped, and people are surprised by which part survives. Cropping the
 * centre square here makes that visible before it is uploaded.
 */
const TARGET_SIZE = 256;

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

export async function prepareAvatarImage(file: File): Promise<PreparedImage> {
  // `from-image` applies the EXIF orientation, without which photographs taken
  // on a phone arrive rotated.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bitmap) throw new Error('That file could not be read as an image.');

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_SIZE;
  canvas.height = TARGET_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot process images.');

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  // Centre crop to a square, then scale: the same thing `object-fit: cover`
  // does when rendering, decided once here instead.
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  context.drawImage(bitmap, sx, sy, side, side, 0, 0, TARGET_SIZE, TARGET_SIZE);
  bitmap.close();

  // PNG keeps transparency, which a logo or a cut-out avatar depends on;
  // photographs are far smaller as JPEG and lose nothing visible at this size.
  const wantsAlpha = file.type === 'image/png' || file.type === 'image/webp';
  const blob = await toBlob(canvas, wantsAlpha ? 'image/png' : 'image/jpeg', 0.92);

  if (blob.size > AVATAR_MAX_BYTES) {
    // Only reachable for a detailed PNG; JPEG at this size never gets close.
    const fallback = await toBlob(canvas, 'image/jpeg', 0.9);
    return { blob: fallback, width: TARGET_SIZE, height: TARGET_SIZE };
  }
  return { blob, width: TARGET_SIZE, height: TARGET_SIZE };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      type,
      quality,
    );
  });
}
