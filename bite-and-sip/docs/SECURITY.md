# Bite & Sip — Security Model

Everything below is enforced in the database (`supabase/migrations/`). The browser holds only the publishable key, and tests in `tests/db/security.test.ts` check both allowed and denied operations against a real Supabase stack.

## Actors
| Actor | Postgres role | Identity check |
|---|---|---|
| Student | `anon` | none; order ownership proven by a device secret |
| Staff | `authenticated` | **and** an active row in `public.staff` (signing in alone grants nothing) |
| Admin scripts | `service_role` (secret key) | trusted machine only |

## Controls
1. **RLS on every public table.** Policies are per command, scoped `to anon`/`to authenticated`, and use `(select private.is_staff())` / `is_owner()`. These helpers are SECURITY DEFINER functions with `search_path=''` in the non-exposed `private` schema.
2. **Grants are least privilege.** Supabase grants ALL on new tables by default (verified), so the migration revokes everything and re-grants:
   - `anon`: SELECT on menu tables + settings + tables, and EXECUTE on 5 customer functions. **No access to `orders`, `order_items` or `staff`.**
   - `authenticated`: column-limited UPDATE on `orders (status, payment_status, payment_reference, cancel_reason)`, settings columns and staff columns. INSERT/UPDATE/DELETE on menu tables (further limited by RLS + triggers).
   - Default privileges for future objects are revoked too.
3. **Authoritative pricing.** `place_order()` ignores any client price, reads `menu_items`/`addons`, checks availability and ownership of each add-on, rejects duplicates, bad quantities, oversized carts and malformed JSON, and computes line and order totals. `order_items.line_total = unit_price × quantity` is a CHECK constraint.
4. **State machine in a trigger** (`private.orders_guard`, runs for every caller): legal transitions only; completed requires paid; paid → unpaid owner-only; cancel needs a reason; customer actions are limited to cancelling a placed, unpaid order and setting `customer_reported_paid_at`; identity, customer and amount columns are immutable; deletes are blocked except for admins.
5. **Kitchen limits.** A trigger lets kitchen staff change only `is_available` on items and add-ons. Owners cannot demote or deactivate themselves (no lock-out).
6. **Anonymous order access.** The device creates a 256-bit secret. Only `sha256(secret)` is stored. `get_order` needs id + secret, and a wrong secret gives the same `order_not_found` as a missing order. Phone numbers are never returned to students (last 4 digits only). Order numbers (`BS-1042`) are display labels, never authorisation.
7. **Idempotency.** `client_request_id` is unique. Retries with the same secret return the original order; a different secret is rejected. Concurrent duplicates are handled with `ON CONFLICT` (tested with 5 parallel calls).
8. **Concurrency.** Staff updates include the expected current status (`.eq('status', from)`). A stale update matches 0 rows and the UI refetches.
9. **Realtime.**
   - Staff: Postgres Changes on `orders`, which respects RLS (non-staff subscribers receive nothing; tested).
   - Students: a public broadcast topic `order:<random track_key>` whose payload is only status, payment status and timestamp, so no personal data. The device then refetches with its secret.
10. **Storage.** `menu-images` bucket: public read, 2 MB limit, JPG/PNG/WebP only, writes owner-only (tested: kitchen and anon denied, HTML upload rejected).
11. **Abuse limits.** Max 3 open orders per phone number. The café-closed switch stops new orders. Kitchen can cancel spam with a reason.
12. **Web hardening** (`vercel.json`): strict CSP (`script-src 'self'`, connections only to Supabase), `frame-ancestors 'none'`, nosniff, referrer policy, HSTS, permissions policy. The CSV export neutralises spreadsheet formulas.
13. **Secrets.** Only `VITE_` public values reach the bundle. The secret key is used by `scripts/create-staff.mjs` alone.

## Known limitations / residual risk
- **UPI is not cryptographically verified.** Staff confirm manually. Mitigations: explicit UI, a reminder not to trust screenshots, an optional UTR reference, refunds-due reporting.
- **No CAPTCHA or IP rate limit** on anonymous ordering. A determined spammer can rotate phone numbers. Mitigation path: Cloudflare Turnstile + an Edge Function in front of `place_order` (Phase 2 if abuse appears).
- The student's tracking topic name is visible to anyone who sees their screen. It reveals only status changes, not personal data.
- Device secrets live in `localStorage`. Clearing browser data loses access to the order page (the student can still show their order number at the counter).
- Phone numbers are personal data. Set a retention routine (see `IMPLEMENTATION_PLAN.md`).
