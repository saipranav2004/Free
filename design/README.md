# PAM/IAM Console — enterprise redesign pass

Design work only. **No production code has been changed** — `UI.zip` and
`backend.zip` are untouched. Everything here is audit, reasoning, a design
system, and reviewable mockups.

## Read in this order

| File | Phase | What it is |
|---|---|---|
| [`01-audit.md`](01-audit.md) | 1 | Every route and sub-screen, the real API surface each uses, and 14 specific findings (F-01…F-14) with file:line evidence |
| [`02-research.md`](02-research.md) | 2 | Per-page references (CyberArk, Teleport, StrongDM, Okta, Entra, Vault, Secrets Manager, Datadog, Linear, Stripe) with the *mechanism* extracted, not the look |
| [`03-personas.md`](03-personas.md) | 3 | Root / Admin / Normal User, verified against the actual route guards, OPA bundle and service-layer rank checks — several standard PAM assumptions are wrong for this product |
| [`04-design-system.md`](04-design-system.md) | 4 | Type scale, 4px grid, colour discipline, elevation rules, table density, navigation model, the four mandatory states |
| [`05-redesigns.md`](05-redesigns.md) | 5 + 6 | Per-page: layout, what changed and why, component fixes, role variants, every action mapped to an endpoint, "requires backend support", and the responsive + Chrome/Edge spec |
| [`mockups/`](mockups) | 5 | The mockups, as a runnable React + Vite app |

## Running the mockups

```bash
cd design/mockups
npm install
npm run dev          # http://localhost:5174
```

Use the **Viewing as: User / Admin / Root** switch in the top bar to see every
role-conditional branch. That switch is a review affordance, not a proposed
product feature.

Routes: `/`, `/resources`, `/resources/:id`, `/vault`, `/vault/:safeId`,
`/vault/:safeId/credentials/:id`, `/sessions`, `/jit`, `/jit/requests/:id`,
`/activity`, `/settings`, `/admin/jit`, `/admin/identity`,
`/admin/identity/:id`, `/admin/roles`, `/admin/policies`,
`/admin/mfa-policy`, `/admin/audit`, `/admin/compliance`, `/admin/vault-ops`,
`/login`, `/mfa-verify`, `/denied` (the permission-denied state), and a 404.

## The rules these mockups were built under

- **No fabricated capability.** Every button, field and data point maps to an
  endpoint already in `UI/src/api/*.js`. Where a page would genuinely be
  better with something the backend doesn't have, it is listed in
  "Requires backend support" — 16 items, consolidated at the end of
  `05-redesigns.md` — and **not** drawn.
- **No fabricated data.** Fixtures are shaped exactly like the Go models'
  JSON, with the enum values from `config/constants.js` and this deployment's
  actual resource types (postgresql, mongodb, redis, clickhouse, minio,
  qdrant, metabase, langfuse, web, oracle).
- **No trend that the API cannot produce.** `GET /admin/stats` returns
  point-in-time counts with no history, so there is not one delta, arrow or
  sparkline anywhere. The one chart in the product is computed from audit rows
  the API actually returns, and says so, with its sample size.
- **Presentation only.** No data fetching, no mutations, no auth. Wiring these
  to real data is a separate pass and needs sign-off first.

## What was verified rather than assumed

- 24 routes × 3 roles rendered in headless Chromium: **0 runtime errors**.
- Horizontal page overflow at 390 / 820 / 1280 / 1920 px on the shell and the
  densest table: **0px**. Tables scroll inside their own container with the
  identity column frozen; the page body never scrolls sideways.
- Light and dark themes both painted from the same token set.
- The design system is enforced by the toolchain: `tailwind.config.js`
  **replaces** Tailwind's type, spacing, radius and shadow scales rather than
  extending them, so an off-scale value simply doesn't compile.

## Three findings worth reading before the design work

1. **F-03 — a Normal User's "your activity" is the whole organisation's.**
   `fetchSelfAuditSample` never sends `user_id`, the audit handler doesn't
   scope by caller, and the seeded `user` role holds `pam:audit:Read` on `*`.
   The mockups fix the labelling client-side; **the exposure is a backend
   decision** and is item #1 on the backend list.
2. **F-04 — permission denied does not exist as a state.** `AdminRoute`
   silently redirects to `/`; `QueryState` renders a 403 as "Couldn't load
   this data" with a Retry button.
3. **F-01/F-02 — an orphan route and a dead page.** `/audit` is routed but
   commented out of the nav; `AdminOverviewPage.jsx` (462 lines) is imported
   by nothing.

## Status

This is a **review pass**. Nothing here is production code, and nothing should
be wired to live data until the direction is signed off.
