# Bite & Sip — Review of the Supplied Designs

Seven images were reviewed: Section 1 (entry → order), Section 2 (menu discovery), Owner/Admin flow, Kitchen/Inventory/Cash/Audit/Reports, Student flow C01–C09, the component wireframe sheet, and the logo.

## What the designs got right (kept)
- QR → menu → item → cart → checkout → confirmed → live tracking.
- Cash or UPI at checkout. UPI "do not mark as paid automatically" (Section 1, step 8).
- Supabase realtime for status updates.
- Empty, sold-out, offline, loading, error and toast states (C-flow and wireframes).
- One responsive web app for students, kitchen and owner.
- Category tabs, search, item details sheet with add-ons and special instructions, floating cart bar.

## Contradictions and how they were resolved
| # | Contradiction in the images | Decision |
|---|---|---|
| 1 | Two brands: **Bite & Sip** (yellow/black) vs **CafeFlow** (navy/orange), and order IDs `#BS-1042` vs `#CF-1042` | Bite & Sip everywhere. Order numbers are `BS-<n>`. Palette sampled from the logo. |
| 2 | Pickup vs delivery: "collect from the counter" but statuses include **Out for Delivery** and a "Send to Delivery" button even for table T12; classroom delivery in C05 | **Counter pickup only.** No delivery status, no classroom addresses. The table is a staff hint. |
| 3 | Status sets differ: Placed/Accepted/Preparing/Ready/Delivered vs New/Accepted/Preparing/Ready/Out for Delivery/Delivered/Cancelled | `placed → preparing → ready → completed`, plus `cancelled`. "Accept" merged into "Start preparing" (one less tap at rush hour). |
| 4 | No "waiting for UPI verification" state anywhere | Payment is separate from status. UPI shows *not paid yet → check payment → paid*. |
| 5 | Add-on prices: Extra Cheese +₹15 (Section 1) vs +₹10 (C03, wireframes); Extra Masala +₹5 vs "Extra Spicy +₹0" | One dataset (`src/data/catalog.json`): Extra Cheese +₹15, Extra Masala +₹5, Extra Vegetables +₹10. Used by demo, seed and tests. |
| 6 | Cash Summary: cash ₹2,450 + UPI ₹5,000 = ₹7,450, which matches neither inflow ₹8,450 nor net ₹7,210 | Reports have one invariant: Sales = cash collected + UPI confirmed + outstanding. Enforced in SQL and in tests. |
| 7 | Outflow table sums to ₹2,700 but shows total ₹1,240. One purchase (₹1,600) exceeds "Total Expenses" ₹1,240 | Expenses are out of MVP scope (Phase 2). No unverifiable figures are shown. |
| 8 | Daily Closing sales ₹8,460 vs ₹8,450 elsewhere | Same as above: every figure comes from one query. |
| 9 | Audit log: "Maggi price ₹40 → ₹50" while every menu shows ₹40 | Dataset keeps Maggi at ₹40. Audit log is out of scope (see #12). |
| 10 | "Out of Stock: Stock **> 0**" | Inventory is Phase 3. Its rule will be `stock ≤ 0`. |
| 11 | "Mon, 02 Oct 2026". 2 Oct 2026 is a **Friday** | Dates are formatted by `Intl` in Asia/Kolkata, never hand-written. |
| 12 | Owner sign-up, email OTP, cafeteria setup wizard, audit log with IP addresses, payroll-like staff module, 7 report types, Excel export | Removed. One café means one owner account, provisioned once. Reports reduced to what reconciles daily cash. CSV export kept. |
| 13 | Missing: café open/closed, merchant UPI configuration, QR generation | Added in Settings (open/closed + message, UPI ID + test QR, tables + printable QR). |
| 14 | Name and phone asked **before** the menu (Section 1, step 2) | Moved to checkout. Browsing needs no data entry. |
| 15 | Location asked both before the menu (Section 1) and after the cart (C05) | The table comes from the QR, and the student can clear it in the cart ("Not at T12?"). No location form. |
| 16 | Section 2 extras: recommendations, "frequently ordered together", recently viewed, sort, price range, veg filter | Dropped for ~15 items. Kept search, categories and a "Popular right now" row. |

## Review of our own interactive mockups (demo mode)
Run on 390 px phone, 820 px tablet and 1366 px desktop:

| Finding | Fix |
|---|---|
| Hero pushed the menu below the fold on phones | Shorter hero; menu starts above the fold |
| Food art letterboxed in sheets/cards | Tile background fills the box; art centred |
| Validation errors stayed after the field was fixed | Errors clear on edit |
| Toasts covered the header on phones | Toasts sit above the cart bar on phones |
| Two yellow (primary) buttons on one ticket | Only the next status step is primary; "Check UPI payment" is secondary until the order is ready |
| Sold-out rows used opacity, which dropped text contrast to 3.0:1 (axe) | Greyscale image + label; text keeps full contrast |
| Scrollable tables not keyboard-reachable (axe) | Focusable labelled regions |
| Hero on desktop narrower than header | Full-width black band; content aligned to the menu column |
| Hourly chart showed only hours with sales | Full 8am–8pm day with empty hours |
