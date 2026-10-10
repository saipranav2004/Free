# Bite & Sip — Design System

Source of truth: tokens in `src/index.css` (`@theme`), components in `src/components/ui.tsx`.
Rationale and contrast measurements: `RESEARCH.md §4`.

## Principles
1. **Black is identity, yellow is action.** Black carries the brand (headers, hero, cart bar, staff bar). Yellow marks the single next step. Yellow text never sits on a light background.
2. **One primary action per view or ticket.** Secondary actions are outlined; destructive ones are red text.
3. **Student = calm and fast** (thumb-reach, big targets). **Kitchen = glanceable** (24 px order numbers, timers, notes highlighted). **Owner = clear** (tables, plain labels).
4. **Honest states.** Nothing says "paid" until staff confirm it, and "Live" only shows while the realtime connection is up.

## Colour tokens
| Token | Hex | Use |
|---|---|---|
| `ink` | #111111 | Text, identity surfaces, dark buttons |
| `ink-2` | #2B2926 | Secondary text, chart bars |
| `muted` | #6B6457 | Supporting text (5.7:1 on canvas) |
| `subtle` | #756D5F | Placeholders, tertiary text (≥4.5:1) |
| `canvas` | #FFFBF2 | Student background (warm cream) |
| `sunken` | #F6F1E6 | Staff background, wells |
| `surface` | #FFFFFF | Cards, sheets |
| `line` / `line-strong` | #E9E2D3 / #D6CCB8 | Dividers (decorative) |
| `field` | #8C8270 | Borders of inputs and controls (3.8:1, WCAG 1.4.11) |
| `brand` | #FCC014 | Primary buttons, selected, "ready" hero, table chip. Always with ink text (11.4:1) |
| `brand-strong` | #E5A800 | Hover/pressed yellow, rings |
| `brand-soft` | #FFF3C4 | Selected rows, kitchen notes |
| `brand-ink` | #8A5D00 | Yellow-family *text* on light backgrounds (5.8:1) |

**Status** (text on its soft background, all ≥ 4.6:1): placed `#1D4ED8`/`#EAF1FF` · preparing `#A15C07`/`#FFF1D6` · ready `#12723A`/`#E4F6EA` · completed `#57534E`/`#EFECE6` · cancelled/danger `#B91C1C`/`#FDECEC`. Veg `#15803D` (square-dot mark), non-veg `#9A3412` (triangle), following the Indian food-label convention.

Status is **never colour alone**: badges have a dot plus a label, payment badges add ✓ or ⚠.

## Typography
Plus Jakarta Sans Variable (self-hosted via Fontsource, no third-party request). Base 16 px. Inputs are always 16 px to prevent iOS zoom.

| Role | Size / weight |
|---|---|
| Page title | 24–36 px / 800, tight tracking |
| Section title | 18 px / 800 |
| Body | 15–16 px / 400–600 |
| Caption | 12–14 px / 600 |
| Order number (student) | 48 px / 800 |
| Order number (kitchen ticket) | 24 px / 800 |
| Numbers | `tabular` figures everywhere money or time appears |

## Spacing, radius, elevation
- 4 px base scale (Tailwind). Page gutters 16 px on phones. Cards pad 16–20 px.
- Radii: inputs 12 px, cards 16 px, sheets 24 px, chips and badges pill-shaped.
- Shadows: `card` (hairline) and `float` (cart bar, toasts, dialogs) only.

## Layout and breakpoints
| Breakpoint | Student | Staff |
|---|---|---|
| < 640 px | Single column, bottom sheets, sticky cart bar | Board as tabs (New/Preparing/Ready), nav under header |
| ≥ 640 px | Dialogs centred | — |
| ≥ 768 px | Content max 768 px | Nav inline in header |
| ≥ 1024 px | — | Board shows 3 columns |

Checked automatically: no horizontal overflow on any page at phone (Pixel 7) and desktop (1366 px) sizes.

## Components
| Component | Variants / states |
|---|---|
| Button | primary (yellow), dark, secondary (outlined), ghost, danger, success · sm 36 / md 44 / lg 52 px · loading (spinner + `aria-busy`), disabled |
| Chip (category/date) | default, hover, selected (black + yellow text, `aria-pressed`) · 44 px tall |
| Field | default, focus (ink border + ring), invalid (`aria-invalid` + message linked by `aria-describedby`), disabled |
| Quantity stepper | min/max disabled ends, live-announced value, labelled ± buttons |
| Switch | `role=switch`, green when on, label required |
| Badge | order status, payment (cash due / UPI pending / UPI check / paid) |
| Food tile | photo if uploaded, otherwise illustrated tile by item type; greyscale + "Sold out" when unavailable |
| Dialog / sheet | native `<dialog>`: focus trap, Esc, backdrop click; bottom sheet on phones |
| Toast | success/error, polite live region, 3.5 s (errors 6 s) |
| Banner | info / warning / danger (`role=alert`) / success |
| Empty state | icon, title, one-line help, one action |
| Order ticket (staff) | header (number, status, name, phone last 4, table, timer chip), items with add-ons and highlighted notes, total + payment, one primary action |
| Cart bar | black, count + total, yellow "View cart" |

## Motion
Only to explain change: sheet/toast slide-up (220 ms), pulse ring on the current tracking step, colour transitions. `prefers-reduced-motion` disables all of it.

## Accessibility requirements (met and tested)
WCAG 2.1 AA contrast (computed, plus axe in E2E) · touch targets ≥ 44 px for primary controls · every input labelled · errors announced and linked · focus visible (3 px ink outline) · dialogs trap focus and close on Esc · live regions for status changes and toasts · `lang="en"` · images decorative unless meaningful (QR codes have descriptive alt text) · scrollable regions focusable · no information conveyed by colour alone.
