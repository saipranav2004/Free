# Bite & Sip — Implementation Plan

## Architecture
```
Browser (React 19 + Vite + Tailwind v4, React Router)
  ├─ src/backend/types.ts      Backend interface (one contract for the whole UI)
  ├─ src/backend/supabase.ts   Production: supabase-js → PostgREST RPC/tables, Realtime, Storage
  ├─ src/backend/demo.ts       Demo/mockup: in-browser store mirroring the DB rules
  ├─ src/lib/*                 Pure logic: pricing, order rules, UPI link, validation, reports
  ├─ src/state/*               Cart, device secrets, menu data, staff session
  └─ src/pages/{student,staff} Screens
Supabase
  ├─ supabase/migrations/      Schema, RLS, grants, triggers, functions, storage, realtime
  ├─ supabase/seed.sql         Generated from src/data/catalog.json (dev/demo only)
  └─ scripts/create-staff.mjs  Staff provisioning (secret key, trusted machine)
```
No custom server: everything privileged happens in Postgres functions and triggers, so there is nothing else to host or secure.

## MVP phases (done)
| Phase | Scope | Status |
|---|---|---|
| 0 | Research, review of the supplied designs, product spec | ✅ |
| 1 | Schema + security model + DB tests | ✅ 46 tests |
| 2 | Design system, demo backend, interactive mockups of all journeys | ✅ |
| 3 | Student app: menu, sheet, cart/checkout, UPI, tracking, my orders | ✅ |
| 4 | Staff app: login, live board, payments, menu admin, reports, settings, QR printing | ✅ |
| 5 | Tests (unit, component, DB/security, E2E on demo **and** local Supabase), accessibility, responsive checks | ✅ |
| 6 | Deployment config (Vercel, CSP), docs | ✅ — live deploy needs account access (see `PROJECT_STATE.md`) |

## Phase 2: money in, money out (not built)
- **Expenses** table (date, category, description, amount, created_by) with owner-only RLS.
- **Daily closing**: a snapshot per business day (expected cash = cash collected; counted cash entered by owner; difference; UPI confirmed vs the bank statement; refunds paid), locked once saved.
- **Refund tracking**: mark refunds due as paid (method, by whom).
- Optional **abuse protection**: Cloudflare Turnstile token checked by an Edge Function wrapping `place_order`.
- **Data retention job**: `pg_cron` monthly — replace `customer_phone` with a hash for orders older than 90 days.

## Phase 3: inventory (not built)
- `inventory_items` (unit, min_stock) and a single `stock_movements` ledger (type: purchase | usage | wastage | adjustment; quantity; cost; note; by; at). Stock = sum of movements, so there are no separate purchase/usage/wastage tables.
- States: healthy (stock ≥ min), low (0 < stock < min), **out (stock ≤ 0)**. This fixes the "> 0" label in the mockups.
- Optional later: recipe links from menu items to automatic usage, and auto-mark sold out at 0.

## Payment gateway (prerequisites, if ever needed)
Only worth it if manual UPI checks become a bottleneck.
1. A registered business entity, bank account and KYC with a PSP (e.g. Razorpay, Cashfree, PhonePe PG).
2. An Edge Function to create payment orders server-side, plus a **webhook** endpoint that verifies signatures and sets `payment_status = paid` with the PSP reference (a new trusted actor in `orders_guard`).
3. Fees (typically ~0–2% for UPI depending on PSP and policy), settlement delays, refund APIs.
4. Keep manual verification as a fallback during PSP outages.

## Deliberately excluded
Delivery and classroom addresses · student accounts and OTP · owner sign-up/OTP/setup wizard · audit log with IP addresses · payroll-like staff module · recommendations, "frequently bought together", sort and price filters · taxes/GST invoices · multi-café.
