// Menu photos bundled with the app live under /menu/<slug>.webp (960 px) with a
// /menu/<slug>-sm.webp (480 px) twin. Owner uploads live in Supabase Storage.
const BUNDLED = /^\/menu\/([a-z0-9-]+)\.webp$/

export function isBundledImage(path: string | null | undefined): boolean {
  return !!path && BUNDLED.test(path)
}

/** Paths in Storage (or demo data URLs) that the app may delete when replaced. */
export function isRemovableImage(path: string | null | undefined): boolean {
  return !!path && !isBundledImage(path)
}

export function bundledImage(path: string | null | undefined) {
  const slug = path?.match(BUNDLED)?.[1]
  if (!slug) return null
  const base = import.meta.env.BASE_URL
  return {
    src: `${base}menu/${slug}.webp`,
    srcSet: `${base}menu/${slug}-sm.webp 480w, ${base}menu/${slug}.webp 960w`,
  }
}
