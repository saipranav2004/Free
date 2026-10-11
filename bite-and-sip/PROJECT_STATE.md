# Bite & Sip — Project State

_Last updated: 11 Oct 2026 (IST), branch `ccr-e77530a6-crvjkv`._

▶ Walkthrough video: `docs/media/walkthrough.mp4` (recorded on a real local Supabase backend; see `docs/VIDEO.md`).

## Current phase
**MVP built and verified locally. Waiting on external accounts (Supabase project + Vercel) for the live deployment.**

## Completed
- Research (reference projects, Supabase/UPI primary docs, yellow-and-black UI/UX research with contrast measurements): `docs/RESEARCH.md`.
- Product spec, user flows, design review (16 contradictions resolved), design system, mockup plan.
- Database: 2 migrations covering schema, RLS, least-privilege grants, state-machine trigger, kitchen/owner guards, customer RPCs, owner reporting, storage bucket and policies, realtime publication. Seed generated from the shared dataset.
- Frontend:
  - Student: QR table entry, menu (search, categories, popular, sold out), item sheet, cart + checkout, cash/UPI, live tracking, self-cancel, my orders.
  - Staff: login, role-aware nav, live board (chime, timers, conflict handling), UPI verification, cash at handover, cancellations, menu CRUD with photos and add-ons, categories, availability, reports + CSV, settings (open/closed, UPI + test QR, tables, printable QR, staff access).
- Demo backend for interactive mockups and previews (labelled "Demo mode").
- Vercel config with SPA rewrites and security headers (CSP verified in a browser).
- **Iteration 2:**
  - brand intro from the café logo (once per session, skippable, reduced-motion aware, doubles as the loader)
  - 14 real, licence-checked food photos with credits page
  - view transitions, staggered reveals, fly-to-cart, order-placed and ready celebrations, kitchen new-order highlight
  - "How it works" footer
  - fixes: toasts blocking taps, nested link/button
  - dev-only sample-history seed
  - scripted walkthrough video

## Key decisions
Counter pickup only · statuses `placed→preparing→ready→completed` + `cancelled` · payment `unpaid/paid` kept separate, with UPI "customer says paid" shown as a claim only · completion requires paid · paid→unpaid owner-only · device-generated 256-bit order secret (hash stored) for anonymous access · prices computed only in SQL · max 3 open orders per phone · IST business day · black = identity, yellow = action. Details: `docs/PRODUCT_SPEC.md`, `docs/SECURITY.md`.

## Tests executed (all passing)
| Suite | Result |
|---|---|
| Lint | 0 errors (11 style warnings) |
| Typecheck, build | pass |
| Unit + component | 29/29 |
| DB/security on local Supabase | 47/47 (also from a cold reset) |
| E2E demo (phone + desktop) | 20/20 |
| E2E local Supabase (phone + desktop) | 20/20 |
Full detail and defects fixed: `docs/TESTING.md`.

## Outstanding / external dependencies
1. **Live deployment not done.** This cloud environment's network policy blocks `api.vercel.com` (proxy 403), and no Vercel or Supabase credentials are available here. Either:
   - **(recommended)** Import the GitHub repo in the Vercel dashboard (Root Directory `bite-and-sip`), see `docs/DEPLOYMENT.md` §4, or
   - allow `api.vercel.com` (and `api.supabase.com`) in this environment's network settings and provide tokens, and the deploy can be scripted.
2. **Supabase project:** create it, `npx supabase db push`, turn off sign-ups, create the owner/kitchen accounts (`docs/DEPLOYMENT.md` §3).
3. **Real UPI ID** in Settings, then test with ₹1 on a real phone.
4. Print the table QR codes from the final domain.
5. Manual checks not automatable here: iOS Safari, real UPI apps, paper printing.

## Next concrete actions
1. Push branch, then import it in Vercel. Until the Supabase keys are added, the site runs in demo mode.
2. Create the Supabase project, apply migrations, add the env vars in Vercel, redeploy.
3. Run through the go-live checklist in `docs/DEPLOYMENT.md` §7.
4. Phase 2 candidates (only if needed): expenses + daily closing, refund tracking, CAPTCHA on ordering, phone-number retention job.
