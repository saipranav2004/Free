# Phase 4 — The design system

Locked once, applies to every page. Implemented in
`design/mockups/src/styles/tokens.css` + `tailwind.config.js` so the mockups
are the spec, not an illustration of it.

---

## 4.1 Type

**One family.** Inter (system fallback stack). `JetBrains Mono` for
identifiers, hashes, hosts, ports, paths, policy rules — anything the user
might copy or compare character-by-character.

**Root font-size returns to 16px.** The current build sets
`html { font-size: 14.5px }` and steps it at 1800px and 2400px (F-09). It
works, but it means "4px" is really 3.625px and changes twice — there is no
grid. Density comes back from the *scale*, not from shrinking the root.

Seven steps. Anything not on this list is a bug.

| Token | px / rem | Line height | Used for |
|---|---|---|---|
| `text-micro` | 11 / 0.6875rem | 16px | Column headers, meta chips, timestamps in dense rows |
| `text-xs` | 12 / 0.75rem | 16px | Secondary row text, captions, helper text |
| `text-sm` | 13 / 0.8125rem | 20px | **Table body, form labels, buttons — the workhorse** |
| `text-base` | 14 / 0.875rem | 20px | Body prose, drawer/detail values |
| `text-lg` | 16 / 1rem | 24px | Section titles, card titles, detail page identity |
| `text-xl` | 20 / 1.25rem | 28px | Page title (`h1`) |
| `text-display` | 28 / 1.75rem | 32px | **The single hero metric on a page. Never more than one.** |

`text-2xl`+ exists nowhere in the console. The 44px/68px marketing type on the
login screen (F-11) is deleted.

**Two weights per screen, maximum.** 400 (`normal`) and 600 (`semibold`).
No 500, no 700, no 800. Emphasis comes from colour and size, not from a third
weight. Letter-spacing: `-0.01em` on ≥`text-lg`, `+0.06em` on `text-micro`
uppercase labels, `0` everywhere else.

`font-variant-numeric: tabular-nums` on every table, every metric, every
countdown — already true in the current build, kept.

---

## 4.2 Spacing — 4px grid, six values

Only these: **4, 8, 12, 16, 24, 32, 48, 64**. No `py-3.5`, no `gap-2.5`, no
`px-[13px]`. The current build uses `py-3.5`, `gap-3.5`, `mb-3.5`, `pt-4.5`
in several files; those all round to the grid.

| Context | Value |
|---|---|
| Icon ↔ label | 8 |
| Inside a control (button padding-x) | 12 |
| Between controls in a toolbar | 8 |
| Table cell padding | 12 x, 8 y (compact) / 12 y (default) |
| Between a label and its field | 8 |
| Between form rows | 16 |
| Between a section heading and its content | 16 |
| Between sections | 32 |
| Page gutter (desktop) | 32 |
| Page gutter (mobile) | 16 |

Page content caps at **1440px** and centres. Reading-width prose caps at
**72ch**.

---

## 4.3 Colour — neutrals do 90% of the work

**Neutral ramp** (the existing `surface-*` / `ink-*` custom-property system is
kept — it is genuinely good and it already gives light+dark from one flip).
What changes is *usage discipline*, not the ramp.

| Role | Light | Dark |
|---|---|---|
| `--bg-app` | `#F7F8FA` | `#0A0C10` |
| `--bg-surface` | `#FFFFFF` | `#101318` |
| `--bg-subtle` | `#F1F3F6` | `#171B22` |
| `--bg-hover` | `#F1F3F6` | `#1B2029` |
| `--border` | `#E3E7EC` | `#232935` |
| `--border-strong` | `#CBD2DB` | `#333B49` |
| `--text-primary` | `#0F172A` | `#F4F6F8` |
| `--text-secondary` | `#475569` | `#A8B1C0` |
| `--text-tertiary` | `#7A879B` | `#6B7488` |

**One accent: blue.** `#2563EB` light / `#3B82F6` dark. It is allowed in
exactly four places:

1. the primary button,
2. the active navigation item (rail + text),
3. a text link,
4. the focus ring.

That's the whole list. **Not** allowed: card hover borders, icon chips,
section-link arrows, decorative rails on metric tiles, selected-row tint
(selection uses `--bg-subtle` + a 2px left border in `--border-strong`).

**Semantic colour signals state only, never category and never decoration.**

| Colour | Meaning in this product | Example |
|---|---|---|
| Red | Denied, failed, revoked, killed, break-glass active, destructive action | `outcome: DENIED`, `is_breakglass: true`, Kill session |
| Amber | Waiting on a human, expiring soon, partially approved, not-yet-compliant | `PENDING`, `PARTIALLY_APPROVED`, `WAITING`, grant < 12h left |
| Emerald | Active, healthy, verified, enrolled | `ACTIVE` session/grant, chain verified, MFA enrolled |
| Neutral | Everything else — including "0 of something bad" | `active_resources`, ended sessions, expired requests |

Consequence: a zero on a bad counter is **neutral, not green**. Green means
"verified good", not "count is zero"; a green zero trains people to read green
as "fine" and then a green field goes unread.

**Status is a dot + text, not a filled pill.** 6px dot in the semantic colour,
label in `--text-primary`. Filled pills at every severity make a table look
like a Christmas tree; a dot column stays scannable at 200 rows. Filled
treatment is reserved for exactly one case: `is_breakglass`, which should be
impossible to miss.

---

## 4.4 Elevation — default is nothing

| Level | Treatment | Where it's allowed |
|---|---|---|
| 0 — flat | no border, no shadow | **Default.** Sections, stat rails, list groups, form rows, most detail blocks |
| 1 — hairline | `1px solid var(--border)`, radius 8 | Tables, code/rule blocks, the one "container that would otherwise be ambiguous" per view |
| 2 — overlay | `1px solid var(--border)` + `0 8px 24px -8px rgb(0 0 0 / .18)`, radius 10 | **Only** things that float over the page: dropdown, popover, dialog, drawer, toast, command palette |

Banned outright:

- shadows on cards, buttons, toolbars, inputs, KPI tiles;
- `hover:-translate-y-*` on anything;
- the `.edge-lit` inset white highlight;
- `.tex-grid` / `.tex-hatch` decorative textures;
- accent rails across the top of metric tiles;
- radius > 10px on any control or container (pills only on status dots).

Rationale from Phase 2 (P2): every border is a claim that two things are
different. Ten cards on a page make ten claims, all of them equal, which is
the same as making none. Depth in Linear/Stripe/Vercel comes from a heading,
32px of air, and left-aligned content — free, and it scales to a page with 20
sections without turning into a wall.

`Card` is therefore **retired as the default container** and replaced by
`Section` (heading + air). Level 1 survives for tables and rule blocks only.

---

## 4.5 Tables and data density

The table is the primary instrument in this product. Spec:

- **Row height 36px** default, **32px** in compact mode (a per-user toggle
  that persists, like Linear's). Not "card per row" — ever, on any list whose
  items share a schema.
- **Header**: `text-micro`, uppercase, `+0.06em`, `--text-tertiary`,
  `--bg-subtle`, sticky top, 32px tall.
- **Column alignment**: text left; numbers, durations, counts, sizes and ports
  **right**, tabular; status dot column fixed 24px; actions column right-most,
  fixed width, actions revealed on row hover/focus (always visible on touch).
- **Fixed layout with declared widths** — keep the existing `COL` map and
  `table-fixed` from `tableStyles.jsx` verbatim. It is correct.
- **Frozen identity column** — keep `stickyCell` / `stickyHeader` verbatim,
  including their opaque-background fix. This is the one piece of the current
  build that should not be touched at all.
- **Zebra striping: no.** Row separation is a 1px `--border` bottom on the
  cell, which survives horizontal scroll where a striped `<tr>` does not.
- **Selection**: checkbox column, `--bg-subtle` fill + 2px `--border-strong`
  left edge. No blue tint (accent discipline, 4.3).
- **Truncation**: keep `TruncCell` — truncate with a `title` attribute,
  never wrap a table cell to two lines.
- **Row click** opens the detail drawer; **row cmd-click / the name link**
  navigates to the detail route. Both, always, on every table.

Card-per-row is permitted in exactly one place in this product: the
**resource "connect" tile** on a Normal User's empty-ish resource list
(< 8 resources), where the row's purpose is a single large touch target
rather than comparison. Nowhere else.

---

## 4.6 Navigation model

**Persistent left sidebar, 240px.** It is the right model here because the
console has two distinct trees (Console / Admin Center) with 5 + 7 entries —
that does not fit a top nav without a dropdown, and a dropdown hides the
Admin Center from the person who lives in it.

| Breakpoint | Sidebar |
|---|---|
| ≥1280px | expanded, 240px, persistent, section labels visible |
| 768–1279px | icon rail, 56px, tooltips on hover; user can expand (persisted) |
| <768px | off-canvas drawer over a scrim, opened from a hamburger in the top bar; closes on navigate |

Top bar (56px) carries: breadcrumb (left), global search / ⌘K (centre-right),
notifications, theme, user menu. It does **not** carry page actions — those
belong to the page header, adjacent to the content they affect.

**Command palette (⌘K):** the existing `QuickJump` is navigation-only, and its
own comment explains why (no action registry exists). That is the right call
and it stays navigation-only. The palette is **not** a substitute for visible
navigation and no action is reachable *only* through it.

Active state: 2px accent rail on the left edge + accent text + `--bg-subtle`.
One indicator, not three (currently rail + tinted bg + ring + accent icon).

---

## 4.7 The four mandatory states

Every data view defines all four. `QueryState` is extended, not replaced —
its loading/error/empty contract is already good; it is missing 403.

| State | Treatment | Rules |
|---|---|---|
| **Loading** | Skeleton in the **shape of the final layout** — table rows as rows, a metric as a metric-sized block. Never a centred spinner on a page that will render a table. | ≥300ms before showing (avoid flash); keep previous data visible on refetch (`placeholderData`) and mark it stale with a subtle "updating" indicator rather than blanking. |
| **Empty** | Icon (24px, `--text-tertiary`), one-line title, one sentence of *why it's empty*, and the primary action if one exists. | Distinguish **"nothing exists yet"** (offer the create action) from **"nothing matches your filters"** (offer *clear filters*, never the create action). The current build conflates these on 6 pages. |
| **Error** | Hairline container, `--text-primary` title, the **actual server message** from `apiErrorMessage()`, a Retry, and the request id when the response carries one. | Never "Something went wrong". Never swallow the message. |
| **Permission denied (403)** | Distinct from error: lock glyph, "You don't have access to this", **the requirement named** ("This needs the `root` role" / "This needs the `admin` role"), and a link to the page they *can* use. **No Retry button.** | Applies at route level too: `AdminRoute` must render this instead of silently redirecting to `/` (F-04). |

A fifth, related state — **degraded** — for the version-skew endpoints
(⚠ in Phase 1): if `GET /admin/mfa-policy` 404s because the deployment
predates it, the page says "MFA policy is not available on this deployment"
rather than rendering an error.

---

## 4.8 Motion

- Duration 120ms (state change) / 160ms (overlay entrance). Nothing longer.
- Properties: `opacity`, `transform: translate`, `background-color`,
  `border-color`. Never `height`, never `box-shadow`, never `translate` on hover.
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` for entrances, `ease-out` for state.
- `prefers-reduced-motion: reduce` → all animation to 0.01ms. Already correct
  in the current `index.css`; kept verbatim.
- The **only** ambient animation in the product is the live-session pulse dot,
  and only while `status === 'ACTIVE'`.

---

## 4.9 Component inventory after the pass

| Kept as-is | Kept, restyled | Retired |
|---|---|---|
| `tableStyles.jsx` (`stickyCell`, `stickyHeader`, `COL`, `TruncCell`) | `Button` (drop `shadow-card` from secondary, drop `active:translate-y-px`) | `StatCard` — merged into `MetricRail`/hero |
| `lib/fourEyes.js` | `QueryState` (+403, +degraded, + filtered-empty) | `Card` as a default container → `Section` |
| `lib/roles.js` | `EmptyState` (two variants: nothing-yet / no-match) | `Toolbar` as a bordered box → flat toolbar row |
| `useTableState`, `Pagination` | `PageHeader` (one primary action + overflow) | `.tex-grid`, `.tex-hatch`, `.edge-lit*` |
| `ResourceTypeIcon` | `KpiStrip` → `MetricRail` (flat, no box, no icons) | `Masthead` greeting block |
| `ConfirmDialog`, `Drawer`, `Modal` | `Badge` → `StatusDot` + text | `BulkActionBar` **as currently framed** — see below |

**`BulkActionBar`** stays, with one change forced by F-12: since no bulk
endpoint exists, it must show per-item progress and per-item failures
("14 of 17 suspended · 3 failed"), never a single success toast implying an
atomic operation.
