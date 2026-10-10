# Bite & Sip — Product Specification (MVP)

## 1. Problem
Bite & Sip is one college café. At rush hour students queue twice: once to order, once to collect. Staff shout names, lose track of who paid, and can't tell which UPI payments really arrived. The owner has no reliable daily sales figure.

**Goal:** a student can order from their seat in under a minute and know when to collect. The kitchen sees a clean, live queue. The owner gets numbers that add up.

**Non-goals (MVP):** delivery, inventory, expenses, multi-café/SaaS, student accounts, owner sign-up, payment gateway, loyalty, coupons, taxes.

## 2. Users and jobs
| User | Device | Jobs |
|---|---|---|
| Student | Own phone, scanning a table QR | Browse, customise, order, pay (cash or UPI), know when it's ready, see recent orders |
| Kitchen staff | Tablet/phone/laptop at the counter | See new orders instantly, prepare, mark ready, confirm payment, hand over, mark items sold out |
| Owner | Laptop or phone | Everything kitchen does, plus menu, prices, photos, café open/closed, UPI ID, tables and QR codes, staff access, reports |

## 3. Fixed decisions
- Brand **Bite & Sip** (yellow `#FCC014` + black from the logo). "CafeFlow" is dropped.
- **Counter pickup only.** The table number is a hint for staff, not a delivery address.
- React + Vite + Tailwind CSS. Supabase (Postgres, Auth, Realtime, Storage). Hosted on Vercel.
- No student login: name + mobile at checkout. Staff log in with Supabase Auth. Public sign-up is disabled.
- UPI by deep link/QR to the café's own UPI ID, **verified manually by staff**. No gateway.

## 4. Order lifecycle
```
placed ──► preparing ──► ready ──► completed
   │            │           │
   └────────────┴───────────┴──► cancelled
```
| From → To | Who | Rule |
|---|---|---|
| placed → preparing | kitchen, owner | — |
| preparing → ready | kitchen, owner | Student sees "Ready for pickup" |
| ready → completed | kitchen, owner | **Requires payment_status = paid**. A cash order is marked paid in the same step ("Collect ₹X & hand over"). |
| placed/preparing/ready → cancelled | kitchen, owner | Reason required, shown to the student |
| placed → cancelled | student (own order) | Only while unpaid **and** the student hasn't tapped "I've paid" |
| anything else | nobody | Rejected by the database (`invalid_transition`) |

Concurrent updates use an "expected current status" guard. If two staff tap at once, one succeeds and the other is told to refresh.

## 5. Payment lifecycle (independent of order status)
`payment_status` ∈ **unpaid | paid**. For UPI the UI shows three honest states:

| Display | Data | Meaning |
|---|---|---|
| UPI · not paid yet | unpaid, `customer_reported_paid_at` empty | Instructions shown (QR + deep link) |
| UPI · check payment | unpaid, `customer_reported_paid_at` set | The student *says* they paid. **Not proof.** Staff must check the café's UPI/bank app. |
| Paid | paid (`paid_at`, `paid_by`, optional reference) | Confirmed by an authorised staff member |

- unpaid → paid: kitchen or owner (any non-cancelled, non-completed order).
- paid → unpaid: **owner only**, and not after completion.
- Students can never change payment status. Opening a UPI app or returning to the site changes nothing.

## 6. Permissions
| Capability | Student (anon) | Kitchen | Owner |
|---|---|---|---|
| Read menu, settings, tables | ✓ | ✓ | ✓ |
| Place order / read own order (with device secret) | ✓ | ✓ | ✓ |
| Read all orders | ✗ | ✓ | ✓ |
| Change order status, mark paid | ✗ | ✓ | ✓ |
| Reverse a payment | ✗ | ✗ | ✓ |
| Toggle item/add-on availability | ✗ | ✓ | ✓ |
| Edit menu, prices, photos, categories | ✗ | ✗ | ✓ |
| Café open/closed, UPI ID, tables | ✗ | ✗ | ✓ |
| Reports | ✗ | ✗ | ✓ |
| Staff roles/active | ✗ | ✗ | ✓ (not their own) |
| Create staff accounts | ✗ | ✗ | via `create-staff` script (secret key) |

## 7. Ordering rules and limits
- Prices are **computed in the database** from current menu prices. Client totals are display-only, and the cart re-checks prices right before submission.
- Café must be open. Item and every chosen add-on must exist, belong to the item, and be available.
- 1–20 per line, ≤ 30 lines, ≤ 50 units per order. Notes ≤ 120 characters.
- Name 1–40 characters. Indian mobile number (10 digits starting 6–9; `+91`/`0` accepted).
- At most **3 open orders per phone number** (basic abuse limit).
- Unknown or inactive table label → the order is still accepted, with no table.
- Idempotent: the device sends a request id + secret. Retrying returns the same order, never a duplicate.

## 8. Order privacy
- The device generates a 256-bit secret per order. The server stores only its SHA-256 hash.
- Reading an order needs **order id + secret**. A wrong secret looks exactly like a missing order.
- Students see only the last 4 digits of their own phone number.
- Realtime notices to students go to a random topic and carry only status fields.

## 9. Reporting rules
Business day = **Asia/Kolkata** calendar date the order was placed.
- **Sales** = total of non-cancelled orders.
- **Cash collected** = non-cancelled, cash, paid. **UPI confirmed** = non-cancelled, UPI, paid.
- **Outstanding** = non-cancelled, unpaid (split cash/UPI; count of UPI awaiting staff check).
- Invariant: **Sales = Cash collected + UPI confirmed + Outstanding cash + Outstanding UPI.** Tested.
- **Cancelled** orders are excluded from sales. **Refunds due** = cancelled orders that had been marked paid.
- Ranges up to 92 days. CSV export (formula-injection safe).

## 10. Café settings
Open/closed toggle + closed message · UPI ID (empty = cash only) + payee name · tables (add, range-add, deactivate, delete) · printable QR cards per table plus a generic counter QR.

## 11. Data and retention
Orders keep name, phone, items, totals and timestamps for reporting. There is no automatic deletion in the MVP. Recommended: delete or anonymise phone numbers older than 90 days (see `IMPLEMENTATION_PLAN.md`).

## 12. Success measures
Time from scan to order placed (target < 60 s). Share of orders handed over within 15 min. Count of UPI orders still unverified at closing (target 0). Daily reconciliation passes.
