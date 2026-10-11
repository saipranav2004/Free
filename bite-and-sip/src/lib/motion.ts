export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * Flies a copy of `source` (usually the food photo) into the floating cart bar.
 * Purely decorative: skipped for reduced motion and when nothing is on screen.
 */
export function flyToCart(source: Element | null) {
  if (!source || prefersReducedMotion() || typeof document === 'undefined') return
  const from = source.getBoundingClientRect()
  if (from.width === 0 || from.bottom < 0 || from.top > window.innerHeight) return
  const target = document.querySelector('[data-cart-target]')?.getBoundingClientRect()
  const toX = target ? target.left + target.width / 2 : window.innerWidth / 2
  const toY = target ? target.top + target.height / 2 : window.innerHeight - 40
  const size = Math.min(from.width, from.height, 96)
  const ghost = source.cloneNode(true) as HTMLElement
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${from.left + from.width / 2 - size / 2}px`,
    top: `${from.top + from.height / 2 - size / 2}px`,
    width: `${size}px`,
    height: `${size}px`,
    margin: '0',
    borderRadius: '999px',
    overflow: 'hidden',
    zIndex: '70',
    pointerEvents: 'none',
    boxShadow: '0 12px 28px -8px rgb(17 17 17 / 0.45)',
  })
  document.body.appendChild(ghost)
  const dx = toX - (from.left + from.width / 2)
  const dy = toY - (from.top + from.height / 2)
  const anim = ghost.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 90}px) scale(0.7)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.18)`, opacity: 0.4 },
    ],
    { duration: 720, easing: 'cubic-bezier(0.45, 0, 0.2, 1)' },
  )
  const cleanup = () => ghost.remove()
  anim.finished.then(cleanup, cleanup)
}
