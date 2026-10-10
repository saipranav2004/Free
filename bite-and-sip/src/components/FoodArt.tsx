// Illustrated fallback used until the owner uploads a real photo.
type Kind = 'chai' | 'coffee' | 'glass' | 'soda' | 'samosa' | 'sandwich' | 'wrap' | 'egg' | 'noodles' | 'rice' | 'combo' | 'plate'

const TINTS: Record<Kind, string> = {
  chai: '#FCE8C3', coffee: '#EFDCC6', glass: '#EADCCB', soda: '#E4F3D6', samosa: '#FBE3B8', sandwich: '#F8E7C2',
  wrap: '#F6E0C8', egg: '#FFF1BF', noodles: '#FFE7A6', rice: '#F3EBD6', combo: '#FFE9A8', plate: '#F1EBDD',
}

export function foodKind(name: string, category = ''): Kind {
  const n = `${name} ${category}`.toLowerCase()
  if (n.includes('combo')) return 'combo'
  if (/maggi|noodle/.test(n)) return 'noodles'
  if (/rice|biryani|pulao/.test(n)) return 'rice'
  if (/samosa|pakora|puff/.test(n)) return 'samosa'
  if (/sandwich|toast|burger/.test(n)) return 'sandwich'
  if (/wrap|roll|frankie/.test(n)) return 'wrap'
  if (/omelette|egg/.test(n)) return 'egg'
  if (/lime|soda|juice|lemon/.test(n)) return 'soda'
  if (/shake|cold coffee|smoothie|lassi/.test(n)) return 'glass'
  if (/coffee/.test(n)) return 'coffee'
  if (/chai|tea/.test(n)) return 'chai'
  if (/beverage|drink/.test(n)) return 'chai'
  return 'plate'
}

const INK = '#111111'
const BRAND = '#FCC014'
const WHITE = '#FFFFFF'

function Art({ kind }: { kind: Kind }) {
  switch (kind) {
    case 'chai':
    case 'coffee':
      return (
        <g>
          <path d="M38 22c-3 4 3 6 0 10M48 20c-3 5 3 7 0 12" stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round" opacity=".45" />
          <path d="M24 40h40v8c0 12-9 20-20 20s-20-8-20-20z" fill={WHITE} stroke={INK} strokeWidth="3" />
          <path d="M64 44h4a7 7 0 0 1 0 14h-5" fill="none" stroke={INK} strokeWidth="3" />
          <ellipse cx="44" cy="40" rx="20" ry="4" fill={kind === 'chai' ? '#C98B3D' : '#6B4423'} stroke={INK} strokeWidth="3" />
          <path d="M18 74h52" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        </g>
      )
    case 'glass':
      return (
        <g>
          <path d="M30 26h28l-4 48H34z" fill="#F4E6D4" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M32 40h24l-3 34H35z" fill="#A86F3A" />
          <ellipse cx="44" cy="26" rx="14" ry="5" fill={WHITE} stroke={INK} strokeWidth="3" />
          <path d="M50 26 58 10" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        </g>
      )
    case 'soda':
      return (
        <g>
          <path d="M30 26h28l-4 48H34z" fill="#EAF7DD" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <circle cx="40" cy="50" r="2" fill={WHITE} stroke={INK} strokeWidth="1.5" />
          <circle cx="48" cy="60" r="2" fill={WHITE} stroke={INK} strokeWidth="1.5" />
          <circle cx="44" cy="40" r="1.5" fill={WHITE} stroke={INK} strokeWidth="1.5" />
          <path d="M52 20a10 10 0 0 1 14 12z" fill="#9BCB4F" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
        </g>
      )
    case 'samosa':
      return (
        <g>
          <path d="M16 66 40 22l24 44z" fill="#E7A94B" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M40 66 58 34l16 32z" fill={BRAND} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M28 54h12M48 56h8" stroke={INK} strokeWidth="2.5" strokeLinecap="round" opacity=".5" />
        </g>
      )
    case 'sandwich':
      return (
        <g>
          <path d="M14 62 44 26l30 36z" fill="#F7DFA6" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M18 62h52" stroke="#6BAF3D" strokeWidth="5" strokeLinecap="round" />
          <path d="M16 68h56v4H16z" fill="#E9B866" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
        </g>
      )
    case 'wrap':
      return (
        <g>
          <rect x="18" y="34" width="52" height="22" rx="11" transform="rotate(-18 44 45)" fill="#F2D29B" stroke={INK} strokeWidth="3" />
          <ellipse cx="66" cy="37" rx="6" ry="10" transform="rotate(-18 66 37)" fill="#E4572E" stroke={INK} strokeWidth="3" />
        </g>
      )
    case 'egg':
      return (
        <g>
          <ellipse cx="44" cy="52" rx="30" ry="14" fill={WHITE} stroke={INK} strokeWidth="3" />
          <circle cx="44" cy="48" r="9" fill={BRAND} stroke={INK} strokeWidth="3" />
          <path d="M18 30h20v10H18z" fill="#E9B866" stroke={INK} strokeWidth="3" />
        </g>
      )
    case 'noodles':
    case 'rice':
    case 'combo':
    case 'plate':
      return (
        <g>
          {kind === 'noodles' && (
            <path d="M24 42c4-8 8 4 12-4s8 4 12-4 8 4 12-4 6 4 8 2" stroke="#E2A400" strokeWidth="4" fill="none" strokeLinecap="round" />
          )}
          {kind === 'rice' && <ellipse cx="44" cy="42" rx="22" ry="8" fill={WHITE} stroke={INK} strokeWidth="2" strokeDasharray="2 3" />}
          {kind === 'combo' && (
            <g>
              <path d="M56 18h16v8c0 5-4 8-8 8s-8-3-8-8z" fill={WHITE} stroke={INK} strokeWidth="3" />
              <path d="M26 40c4-6 7 3 10-3s7 3 10-3 6 3 9-1" stroke="#E2A400" strokeWidth="4" fill="none" strokeLinecap="round" />
            </g>
          )}
          <path d="M16 44h56c0 16-12 26-28 26S16 60 16 44z" fill={kind === 'plate' ? WHITE : BRAND} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
          <path d="M30 76h28" stroke={INK} strokeWidth="3" strokeLinecap="round" />
        </g>
      )
  }
}

export function FoodArt({ name, category, className = '' }: { name: string; category?: string; className?: string }) {
  const kind = foodKind(name, category)
  return (
    <span className={`flex items-center justify-center ${className}`} style={{ background: TINTS[kind] }} aria-hidden="true">
      <svg viewBox="0 0 88 88" className="h-full max-h-full w-auto" focusable="false">
        <Art kind={kind} />
      </svg>
    </span>
  )
}

export function FoodImage({
  name, category, url, className = '',
}: { name: string; category?: string; url: string | null; className?: string }) {
  if (url) return <img src={url} alt="" loading="lazy" decoding="async" className={`object-cover ${className}`} />
  return <FoodArt name={name} category={category} className={className} />
}
