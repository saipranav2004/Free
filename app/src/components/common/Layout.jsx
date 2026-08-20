import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Page & surface primitives
// ---------------------------------------------------------------------------
// Every page in the console is built from these three (plus Card's slots), so
// vertical rhythm, heading weight, border colour and corner radius are
// decided once here rather than per page.

export function PageHeader({ title, description, actions, eyebrow, meta, breadcrumb }) {
  return (
    <header className="mb-5 border-b border-surface-700/70 pb-4">
      {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold leading-tight text-ink-50">{title}</h1>
          {description && (
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-400">{description}</p>
          )}
        </div>
        {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {meta && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">{meta}</div>}
    </header>
  )
}

// A section band, a labelled horizontal rule that divides a page into
// named zones. Enterprise consoles lean on this instead of stacking cards
// with no hierarchy: the label is chrome (small caps, muted), the rule
// carries the eye across, and an optional action sits at the far end.
export function Section({ label, description, action, children, className = '' }) {
  return (
    <section className={clsx('mt-8 first:mt-0', className)}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-6 text-ink-50">{label}</h2>
          {description && <p className="mt-0.5 max-w-prose text-xs text-ink-400">{description}</p>}
        </div>
        {action && <div className="flex-none">{action}</div>}
      </div>
      {children}
    </section>
  )
}

// The console's one list row. Every list in the app (resources, safes,
// sessions, requests, grants, users, audit entries) is this shape: a framed
// leading glyph, a two-line identity block, and a trailing cluster of status
// and actions. Centralizing it is what makes the app feel like one product
// instead of nine screens that each invented their own row.
export function ListRow({ icon: Icon, iconNode, title, subtitle, trailing, className = '' }) {
  return (
    <div className={clsx('flex items-center justify-between gap-4 px-4 py-3.5', className)}>
      <div className="flex min-w-0 items-center gap-3.5">
        {(Icon || iconNode) && (
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-surface-700 bg-surface-850 text-ink-400 transition-colors group-hover:border-surface-600">
            {iconNode || <Icon className="h-[1.05rem] w-[1.05rem]" strokeWidth={1.5} />}
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink-50">{title}</div>
          {subtitle && <div className="mt-0.5 truncate text-xs text-ink-500">{subtitle}</div>}
        </div>
      </div>
      {trailing && <div className="flex flex-none items-center gap-2.5">{trailing}</div>}
    </div>
  )
}

// Status presence dot, pairs with a Badge when a row needs to signal
// "live" at a glance without another badge competing for attention.
export function StatusDot({ tone = 'ink', live = false, className = '' }) {
  const color =
    {
      emerald: 'bg-emerald-500',
      amber: 'bg-amber-500',
      red: 'bg-red-500',
      blue: 'bg-blue-500',
      ink: 'bg-ink-500',
    }[tone] || 'bg-ink-500'
  return (
    <span
      className={clsx('relative flex h-2 w-2 flex-none rounded-full', color, className)}
      aria-hidden="true"
    >
      {live && <span className={clsx('dot-live absolute inset-0 rounded-full', color)} />}
    </span>
  )
}

// A card is a real surface: 1px border, soft elevation, 12px radius. Content
// that needs to sit flush to the edge (lists, tables) gets no padding, pass
// padding through `className` when the card holds prose instead.
export function Card({ children, className = '', interactive = false, as: As = 'div', ...rest }) {
  return (
    <As
      className={clsx(
        'rounded-xl border border-surface-700/70 bg-surface-900 ',
        // No lift, no glow. A surface that jumps when the pointer crosses it
        // reads as a web page; a console panel answers with its border.
        interactive && 'transition-colors duration-150 hover:border-surface-600 hover:bg-surface-850/40',
        className
      )}
      {...rest}
    >
      {children}
    </As>
  )
}

export function CardHeader({ children, className = '' }) {
  return (
    <div
      className={clsx(
        'flex min-h-[3.25rem] items-center gap-3 border-b border-surface-800 px-4 py-3',
        className
      )}
    >
      {children}
    </div>
  )
}

// Section title used inside cards and above lists, one consistent size and
// weight rather than six different ad-hoc <h2> treatments.
export function CardTitle({ icon: Icon, children, className = '' }) {
  return (
    <h2 className={clsx('flex items-center gap-2 text-base font-semibold text-ink-50', className)}>
      {Icon && <Icon className="h-4 w-4 flex-none text-ink-400" strokeWidth={1.75} />}
      {children}
    </h2>
  )
}

export function CardFooter({ children, className = '' }) {
  return (
    <div className={clsx('flex items-center gap-3 border-t border-surface-800 px-4 py-3', className)}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ListPanel
// ---------------------------------------------------------------------------
// One bordered surface that owns a whole list: its chrome, its rows and its
// pager. This replaces the pattern the console used everywhere, a floating
// filter card, a 16px gap, then a separate table card.
//
// The gap was the problem. A gap between two bordered surfaces says they are
// unrelated things, so the filters read as a widget that happens to sit above
// a table rather than as that table's controls. AWS Console, the Azure Portal
// and Salesforce all draw a single container instead: the toolbar is the
// panel header, the rows are the body, the pager is the footer, and the
// hairlines inside it are what separate the three.
//
// It also fixes the loading and error cases, which used to render outside any
// panel at all, so the page visibly changed shape between "loading" and
// "loaded" instead of filling in.
export function ListPanel({ toolbar, footer, children, className = '' }) {
  return (
    <div
      className={clsx('overflow-hidden rounded-xl border border-surface-700/70 bg-surface-900 ', className)}
    >
      {toolbar && (
        <div className="space-y-3 border-b border-surface-700/70 bg-surface-850/40 px-3 py-3">{toolbar}</div>
      )}
      <div className="min-w-0">{children}</div>
      {footer}
    </div>
  )
}

// A filter/search strip that sits above a list. Distinct from a Card so it
// never reads as "content", it's chrome.
export function Toolbar({ children, className = '' }) {
  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-2 border-b border-surface-700/70 bg-surface-900 px-3 py-2.5',
        className
      )}
    >
      {children}
    </div>
  )
}

// Shared empty state. Every "nothing here" surface in the console uses this
// shape: muted glyph in a framed tile, one line of explanation, optional CTA.
export function EmptyState({ icon: Icon, title, description, action, className = '' }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {Icon && (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-surface-700 bg-surface-850 text-ink-400">
          <Icon className="h-5 w-5" strokeWidth={1.5} />
        </div>
      )}
      <p className="text-base font-semibold text-ink-100">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

// Definition list used on every detail page (resource, credential, request,
// identity) so key/value blocks line up identically across the app.
export function DetailList({ items, className = '' }) {
  return (
    <dl className={clsx('divide-y divide-surface-800', className)}>
      {items.map(({ label, value }) => (
        <div key={label} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(9rem,30%)_1fr] sm:gap-4">
          <dt className="text-sm font-medium text-ink-400">{label}</dt>
          <dd className="min-w-0 break-words text-sm text-ink-100">{value ?? '-'}</dd>
        </div>
      ))}
    </dl>
  )
}
