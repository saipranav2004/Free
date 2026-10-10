import { AppError } from './errors'

const MAX_INPUT_BYTES = 15 * 1024 * 1024
const MAX_SIDE = 1000

/**
 * Shrinks a photo on the device before upload (phones produce 3–8 MB images;
 * the menu needs ~100 KB). Output is WebP, falling back to JPEG.
 */
export async function prepareMenuPhoto(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new AppError('invalid', 'Choose a JPG, PNG or WebP photo.')
  }
  if (file.size > MAX_INPUT_BYTES) throw new AppError('invalid', 'That photo is too large (max 15 MB).')

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AppError('invalid', 'This photo format isn’t supported here. Try a JPG or PNG.')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new AppError('invalid', 'Couldn’t process the photo.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  const toBlob = (type: string, q: number) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, q))
  let blob = await toBlob('image/webp', 0.82)
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.85)
  if (!blob) throw new AppError('invalid', 'Couldn’t process the photo.')
  if (blob.size > 2 * 1024 * 1024) throw new AppError('invalid', 'Photo is still over 2 MB after resizing. Try another photo.')
  return blob
}
