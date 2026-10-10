# Bite & Sip — Information Architecture & User Flows

## Information architecture
```
Student (mobile-first, no login)
├── /t/:table            QR landing → remembers table (6 h) → Menu
├── /                    Menu: hero + search + category chips + popular + list + cart bar
│   └── Item sheet       add-ons, note, quantity
├── /cart                Cart + details + pickup + payment + total + Place order (one page)
├── /order/:id           Live tracking: number, steps, payment card, items, cancel
└── /orders              My orders on this phone (in progress / earlier)

Staff (one app, role-aware)
├── /staff/login
├── /staff               Orders board (kitchen + owner)
├── /staff/menu          Availability (kitchen) · full editing (owner)
├── /staff/reports       Owner
├── /staff/settings      Owner: café status, UPI, tables & QR, staff
└── /staff/print-qr      Owner: printable QR cards
```
Unknown routes show "Page not found". Owner-only routes redirect kitchen users to the board, and signed-out users to login.

## Flow 1: student orders (happy path)
1. Scan the table QR → `/t/T12` → menu shows "Table T12 · Pickup at the counter".
2. Tap **Add** on a simple item (toast "added", stepper appears). Items with add-ons open the sheet instead.
3. The cart bar shows count + total → **View cart**.
4. Enter name and mobile number (remembered next time) → choose **Cash** or **UPI** → **Place order · ₹X**.
5. The app re-checks the live menu. If prices or availability changed it stops and explains, otherwise it places the order.
6. The tracking page opens: "Order placed!", big order number, steps *Received → Preparing → Ready → Collected*.
7. When ready: the card turns yellow, the phone vibrates (if supported) and the tab title shows "Ready!".

## Flow 2: UPI payment
1. Tracking page → Payment card: instructions, **Pay ₹X with a UPI app** (phones), QR (any device), UPI ID with copy.
2. Student pays, returns, taps **I've paid** → badge "UPI · check payment" and "Waiting for the café to confirm".
3. Staff see a yellow-ringed card and "N UPI payments to check" → **Check UPI payment** → dialog shows amount, time, the student's claim and a reminder not to trust screenshots → optional UTR reference → **Received ₹X**.
4. The student's page updates to "Paid". If not received, staff tap **Not received** and talk to the student at the counter.

## Flow 3: kitchen board
- Columns **New → Preparing → Ready for pickup** (tabs on phones). Ticket timer: grey, then yellow, then red.
- New order: chime (if enabled) + toast + tab title count.
- One primary action per card: **Start preparing**, then **Mark ready**, then **Hand over** (paid), **Collect ₹X & hand over** (cash), or **Check UPI payment** (UPI unpaid).
- **Cancel** needs a reason. If the order was paid, a refund warning appears.
- "Finished today" lists collected and cancelled orders, marking any refund due.
- Connection pill shows Live / Reconnecting. A manual refresh button is available.

## Flow 4: owner
- **Menu:** add/edit items (photo resized on the device, price, category, veg, popular, in stock, add-ons) · delete with confirmation · categories (add, rename, reorder, delete when empty).
- **Settings:** open/close café · closed message · UPI ID + payee name + **Test with ₹1** QR · tables (single or range "T13-T20") · print QR codes · staff roles/access.
- **Reports:** Today / Yesterday / 7 days / This month / Custom · KPI tiles · "Where the money is" reconciliation · cancellations & refunds · sales by hour/day · top items · orders table · CSV.

## Error and edge states
| Situation | What the user sees |
|---|---|
| Menu fails to load | Retry screen. If a cached menu exists: inline warning and the last menu |
| Offline | Order page shows "Reconnecting — checking every few seconds". Board shows a "Reconnecting…" pill and polls every 10 s |
| Café closed | Banner on menu and cart. Add and Place order disabled. Cart kept on the phone |
| Item sold out in cart | Line marked "Sold out right now" with Remove. Ordering blocked until resolved |
| Price changed before submit | "Prices were updated. Your new total is ₹X — please review" |
| Network drop during submit | Retry reuses the same request id + secret → no duplicate order |
| Too many open orders | "You already have 3 orders in progress…" |
| Order opened on another phone | "This order isn't on this phone" |
| Two staff act at once | Second one: "Someone else updated this order first. The board has been refreshed." |
| Empty search / empty cart / no orders | Friendly empty state with a next step |
| Kitchen opens owner page | Redirected to the board. Owner links hidden |
