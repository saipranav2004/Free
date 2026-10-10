# Bite & Sip — Interactive Mockup Plan

## Approach
The interactive mockups are **the real UI running on an in-browser demo backend** (`src/backend/demo.ts`). That was a deliberate choice over static screens:
- Every journey is clickable end to end, with real cart maths, validation and state changes.
- The same screens later run unchanged on Supabase (`src/backend/supabase.ts`), so nothing designed in the mockup phase is thrown away.
- The demo shares one fictional dataset (`src/data/catalog.json`) with the database seed (`scripts/generate-seed.mjs`).
- It syncs across browser tabs (BroadcastChannel + storage events), so a "student" tab and a "kitchen" tab react to each other like the real system.

The demo mirrors the database rules (pricing, state machine, role checks), but it is **not secure** and is labelled "Demo mode" on every screen. It is enabled when no Supabase keys are configured, or with `VITE_DEMO_MODE=true`.

Demo accounts: `owner@demo.bitesip` / `demo-owner`, `kitchen@demo.bitesip` / `demo-kitchen` (shown on the login page in demo mode only).

## Journeys covered
| # | Journey | Screens |
|---|---|---|
| S1 | Scan table QR, browse, search, filter | `/t/T12` → Menu |
| S2 | Customise an item (add-ons, note, quantity) | Item sheet |
| S3 | Cart edits, validation, cash order | Cart → Order |
| S4 | UPI order: QR/deep link, "I've paid", wait for verification, paid | Order |
| S5 | Cancel before preparation | Order |
| S6 | Café closed | Menu, Cart |
| S7 | Recent orders on this phone | My orders |
| K1 | Login, live board, start → ready → hand over | Login, Board |
| K2 | Verify UPI with reference; cash collected at handover | Board dialogs |
| K3 | Cancel with reason (refund warning when paid) | Board dialog |
| K4 | Mark item/add-on sold out | Menu (kitchen) |
| O1 | Add/edit/delete item, photo, add-ons, categories | Menu (owner) |
| O2 | Reports by range, reconciliation, CSV | Reports |
| O3 | Open/close café, UPI ID + test QR, tables, print QR, staff access | Settings, Print |

## Validation of the mockups
- Totals checked against the dataset (e.g. Maggi + Extra Cheese ×2 + Chai = ₹125) in unit, component and E2E tests.
- Mockup review findings and fixes are in `DESIGN_REVIEW.md` (second table).
- After review, the same E2E suite was run against a real local Supabase stack and passed, which confirmed that the mockup behaviour matches production behaviour.
