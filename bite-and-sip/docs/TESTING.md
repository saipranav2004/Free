# Bite & Sip — Test Strategy & Results

## Layers
| Layer | Tool | Location | Runs against | What it proves |
|---|---|---|---|---|
| Unit | Vitest | `src/lib/logic.test.ts` | pure functions | Pricing, cart merging, quantity limits, state machine, payment display, UPI link format, phone/name/table validation, IST business days, report reconciliation, CSV escaping, dataset consistency |
| Component | Vitest + Testing Library (jsdom) | `src/test/app.test.tsx` | real screens + demo backend | Menu search/categories/sold-out, add-on pricing in the sheet, cart totals, checkout validation, cash order end to end, closed café, login errors, kitchen blocked from owner pages, reports render |
| Database & security | Vitest (node) + supabase-js | `tests/db/security.test.ts` | **local Supabase** (Postgres + PostgREST + Auth + Realtime + Storage) | Allowed **and denied** operations per role, authoritative pricing, input validation, idempotency incl. concurrent duplicates, order secrets, state machine, payment rules, role escalation, column immutability, reporting maths, realtime privacy, storage policies |
| End-to-end | Playwright (Chromium) | `tests/e2e/ordering.spec.ts` | production build, **demo** and **local Supabase** | Full journeys across two browsers (student + staff), live updates, menu admin, café closure, reports, QR, accessibility (axe WCAG 2 A/AA), no horizontal overflow on 360/412/820/1366 px |

## Commands
```bash
npm run lint && npm run typecheck && npm test && npm run build     # = npm run check
npx supabase start                                                 # once, needs Docker
npm run test:db                                                    # DB/security suite
npm run test:e2e                                                   # E2E on demo backend
E2E_OWNER_EMAIL=… E2E_OWNER_PASSWORD=… E2E_KITCHEN_EMAIL=… E2E_KITCHEN_PASSWORD=… \
  npm run test:e2e:supabase                                        # E2E on local Supabase
```
Set `PLAYWRIGHT_CHROMIUM_PATH` if Chromium is preinstalled elsewhere.

## Coverage of the required scenarios
| Area | Scenario | Where |
|---|---|---|
| Student | menu loading, search, categories | component, E2E |
| | add-ons and quantities, cart calculations | unit, component, E2E |
| | checkout validation | component |
| | order creation, UPI instructions, tracking | component, E2E (demo + Supabase) |
| | closed café | component, E2E, DB |
| Kitchen | authentication, role permissions | component, E2E, DB |
| | new-order handling, transitions | E2E, DB |
| | UPI verification | E2E, DB |
| | duplicate action prevention | DB (concurrent updates → exactly one winner); UI disables buttons while busy |
| | realtime updates and recovery | DB (broadcast + Postgres Changes, cold-start warm-up), E2E (live updates across browsers) |
| Owner | menu CRUD, add-ons, availability | E2E, DB |
| | image uploads | DB (owner allowed; kitchen/anon/HTML denied) |
| | café settings, QR generation | E2E |
| | sales calculations, date filters | unit, DB (cross-checked against raw rows), E2E |
| Security | unauthorised access, cross-customer access | DB |
| | role escalation, invalid prices/quantities | DB |
| | invalid transitions, unauthorised payment changes | DB |
| | duplicate submissions | DB (sequential and 5× concurrent) |
| UI | mobile/tablet/desktop, no overflow | E2E |
| | accessibility | E2E (axe on 8 pages × 2 viewports), contrast computed in `RESEARCH.md` |
| | broken routes | E2E |

## Results (executed 10–11 Oct 2026, this repository state)
| Check | Result |
|---|---|
| `npm run lint` (oxlint) | 0 errors, 11 warnings (React-compiler style hints: fast-refresh exports, data-loading effects). Reviewed and not defects |
| `npm run typecheck` | pass |
| `npm test` (unit + component) | **29 / 29 passed** |
| `npm run build` | pass (~135 KB gzipped JS) |
| `npm run test:db` (local Supabase) | **47 / 47 passed**, including immediately after `supabase db reset` |
| `npm run test:e2e` (demo) | **16 / 16 passed** (8 tests × phone + desktop) |
| `npm run test:e2e:supabase` | **16 / 16 passed** |
| CSP smoke test | production build served with `vercel.json` headers: no CSP violations, fonts load, QR renders |

## Defects found by testing and fixed
1. Admin/service-role order updates failed (`permission denied for schema private`) because the invoker trigger couldn't reach its helpers. Grants were added, plus a test.
2. Reports chart overflowed phones by 96 px (flex items without `min-width: 0`).
3. Sold-out rows had 3.0:1 text contrast (opacity). Replaced with greyscale art + label.
4. Scrollable tables weren't keyboard-focusable (axe `scrollable-region-focusable`).
5. Field errors persisted after correction. They now clear on edit.
6. Realtime tests were flaky after a cold start. A warm-up was added. This confirmed the need for the app's polling fallback, which already exists.

## Not covered automatically (manual checks recommended)
- Real UPI apps (Google Pay, PhonePe, Paytm, BHIM) opening the deep link and scanning the QR with a live UPI ID. Use **Settings → Test with ₹1**.
- Printing on paper (layout is A4, 2 cards per row).
- Safari/iOS and Firefox (E2E runs on Chromium only).
- Hosted Supabase and Vercel (no account access in this environment; see `PROJECT_STATE.md`).
