import clsx from 'clsx'
import { PageTitle } from '../ui/layout'

// ---------------------------------------------------------------------------
// Page & surface primitives
// ---------------------------------------------------------------------------
// Every page in the console is built from these three (plus Card's slots), so
// vertical rhythm, heading weight, border colour and corner radius are
// decided once here rather than per page.

export function PageHeader({ title, description, actions, eyebrow, meta, breadcrumb }) {
  // The EYEBROW IS DELIBERATELY IGNORED. Every page that passed one passed the
  // section it already sits in, "Admin Center", "Compliance", "Access", which
  // the breadcrumb directly above the title has just said. Two lines of
  // navigation above a heading is how a page header reaches 120px before any
  // data appears.
  return (
    <header className="mb-5">
      {breadcrumb}
      <PageTitle title={title} description={description} actions={actions} />
      {meta && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">{meta}</div>}
    </header>
  )
}

// A named zone on a page: a heading and space, not a box. Boxes are for
// containers that hold a collection; a section just groups.
export function Section({ label, title, description, action, children, className = '' }) {
  const heading = title || label
  return (
    <section className={clsx('mt-8 first:mt-0', className)}>
      {(heading || action) && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {heading && <h2 className="text-xl font-bold leading-tight text-primary">{heading}</h2>}
            {description && <p className="mt-1 max-w-prose text-sm text-secondary">{description}</p>}
          </div>
          {action && <div className="flex flex-none items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

// The console's one list row: an optional leading glyph, a two line identity
// block, and a trailing cluster of state and actions.
export function ListRow({ icon: Icon, iconNode, title, subtitle, trailing, className = '' }) {
  return (
    <div className={clsx('flex items-center justify-between gap-4 px-4 py-3', className)}>
      <div className="flex min-w-0 items-center gap-3">
        {(Icon || iconNode) && (
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-line bg-subtle text-tertiary">
            {iconNode || <Icon className="h-4 w-4" strokeWidth={1.5} />}
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-primary">{title}</div>
          {subtitle && <div className="mt-0.5 truncate text-xs text-tertiary">{subtitle}</div>}
        </div>
      </div>
      {trailing && <div className="flex flex-none items-center gap-2.5">{trailing}</div>}
    </div>
  )
}

// Presence dot. Pairs with a label when a row needs to signal "live" at a
// glance. components/ui/bits.jsx has the richer StatusDot; this one stays for
// the callers that only want the mark.
export function StatusDot({ tone = 'ink', live = false, className = '' }) {
  const color =
    {
      ok: 'bg-ok',
      emerald: 'bg-ok',
      warn: 'bg-warn',
      amber: 'bg-warn',
      danger: 'bg-danger',
      red: 'bg-danger',
      accent: 'bg-accent',
      blue: 'bg-accent',
      ink: 'bg-line-strong',
    }[tone] || 'bg-line-strong'
  return (
    <span
      className={clsx('relative flex h-2 w-2 flex-none rounded-full', color, className)}
      aria-hidden="true"
    >
      {live && <span className={clsx('dot-live absolute inset-0 rounded-full', color)} />}
    </span>
  )
}

// A card is a real surface: a 1px border and a 16px radius, and no shadow.
// Content that sits flush to the edge (lists, tables) gets no padding; pass it
// through className when the card holds prose instead.
export function Card({ children, className = '', interactive = false, as: As = 'div', ...rest }) {
  return (
    <As
      className={clsx(
        'rounded-xl border border-line bg-surface',
        interactive && 'transition-colors duration-150 hover:border-line-strong hover:bg-subtle/40',
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
      className={clsx('flex min-h-[3rem] items-center gap-3 border-b border-line-soft px-4 py-3', className)}
    >
      {children}
    </div>
  )
}

export function CardTitle({ icon: Icon, children, className = '' }) {
  return (
    <h2 className={clsx('flex items-center gap-2 text-lg font-bold text-primary', className)}>
      {Icon && <Icon className="h-4 w-4 flex-none text-tertiary" strokeWidth={1.75} />}
      {children}
    </h2>
  )
}

export function CardFooter({ children, className = '' }) {
  return (
    <div className={clsx('flex items-center gap-3 border-t border-line-soft px-4 py-3', className)}>
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
