import clsx from 'clsx'

// ---------------------------------------------------------------------------
// Page and container primitives
// ---------------------------------------------------------------------------
// Measured against the Cloudscape token set and the AWS Console list and
// detail page patterns. Three rules do most of the work:
//
//   A CONTAINER IS A BORDER, NOT A SHADOW. shadow-card is literally `none` in
//   Cloudscape. Both the page and the container are white; a 1px border at
//   #c6c6cd and a 16px radius are what separate them. Our previous build used
//   a grey page, a white card and a soft shadow, which is the template look.
//
//   A CONTAINER HAS A HEADER, AND THE HEADER CARRIES ITS ACTIONS. Title left,
//   counter next to it, actions right, one hairline underneath. Not a title
//   floating above a card with a button somewhere else on the page.
//
//   NOT EVERYTHING IS A CONTAINER. A page of eight bordered boxes has no
//   hierarchy. Properties of one object go in a KeyValueGrid under a plain
//   heading, with no box at all.

export function Container({ header, footer, children, className, padded = true, id }) {
  return (
    <section id={id} className={clsx('overflow-hidden rounded-xl border border-line bg-surface', className)}>
      {header}
      <div className={clsx(padded && 'p-4')}>{children}</div>
      {footer}
    </section>
  )
}

/**
 * A container's header. `counter` sits beside the title in the muted counter
 * colour, which is how AWS shows "(12)" without it reading as part of the name.
 */
export function ContainerHeader({ title, description, counter, actions, className }) {
  return (
    <header
      className={clsx('flex flex-wrap items-start gap-3 border-b border-line-soft px-4 py-3', className)}
    >
      <div className="min-w-0 flex-1">
        <h2 className="flex items-baseline gap-2 text-lg font-bold leading-tight text-primary">
          <span className="min-w-0 truncate">{title}</span>
          {counter != null && (
            <span className="flex-none text-sm font-normal text-tertiary">({counter})</span>
          )}
        </h2>
        {description && (
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-secondary">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/**
 * The page title block. One line of title, one optional line of description,
 * actions on the right. No eyebrow: the breadcrumb in the top bar already
 * says where you are, and repeating it above a 24px heading is the pattern
 * that pushed our page headers to 120px before any data appeared.
 */
export function PageTitle({ title, description, counter, actions, className }) {
  return (
    <div className={clsx('flex flex-wrap items-start justify-between gap-x-4 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="flex items-baseline gap-2 text-2xl font-bold leading-tight text-primary">
          <span className="min-w-0 truncate">{title}</span>
          {counter != null && (
            <span className="flex-none text-base font-normal text-tertiary">({counter})</span>
          )}
        </h1>
        {description && (
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-secondary">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * Properties of a single object. This is the component that replaces the card
 * walls: ten `<Card>`s on a detail page carrying one label and one value each
 * is ten borders drawn around nothing. Cloudscape puts the same information in
 * a key-value grid with no box per pair, grouped under one container.
 *
 * Columns collapse 4 to 2 to 1 as the viewport narrows.
 */
export function KeyValueGrid({ items, columns = 3, className }) {
  const cols =
    columns === 2
      ? 'sm:grid-cols-2'
      : columns === 4
        ? 'sm:grid-cols-2 lg:grid-cols-4'
        : 'sm:grid-cols-2 lg:grid-cols-3'
  return (
    <dl className={clsx('grid grid-cols-1 gap-x-8 gap-y-5', cols, className)}>
      {items.filter(Boolean).map(({ label, value, hint, span }) => (
        <div key={label} className={clsx('min-w-0', span === 'full' && 'sm:col-span-2 lg:col-span-full')}>
          <dt className="text-sm font-bold text-primary">{label}</dt>
          {/* The hint lives INSIDE the <dd>. A <div> grouping inside a <dl>
              may contain only dt/dd, so a sibling <p> broke the term and
              definition pairing for the whole list. It describes the value, so
              the definition is where it belonged anyway. */}
          <dd className="mt-1 min-w-0 break-words text-sm text-secondary">
            {value === null || value === undefined || value === '' ? (
              <span className="text-tertiary">-</span>
            ) : (
              value
            )}
            {hint && <span className="mt-1 block text-xs text-tertiary">{hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A named zone on a page. A heading and space, not a box. Boxes are for
 * containers that hold a collection; a section just groups.
 */
export function Section({ title, description, actions, children, className }) {
  return (
    <section className={clsx('mt-8 first:mt-0', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-xl font-bold leading-tight text-primary">{title}</h2>}
            {description && <p className="mt-1 max-w-prose text-sm text-secondary">{description}</p>}
          </div>
          {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

/** Vertical rhythm between the blocks of a page. One value, used everywhere. */
export function Stack({ children, gap = 'md', className }) {
  const g = { sm: 'space-y-3', md: 'space-y-4', lg: 'space-y-6' }[gap] || 'space-y-4'
  return <div className={clsx(g, className)}>{children}</div>
}
