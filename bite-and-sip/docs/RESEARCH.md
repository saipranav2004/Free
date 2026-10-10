# Bite & Sip — Research

Research done in October 2026 to ground product, UX and engineering decisions.
Each finding lists the source, what it says, our confidence, and what we did with it.
"Vendor" means a marketing or product source rather than independent research.

## 1. Inputs reviewed

| Input | What it contained | How we used it |
|---|---|---|
| 7 design images (Section 1, Section 2, Owner/Admin, Kitchen/Inventory/Cash, Student flow C01–C09, component wireframes, logo) | Two competing brands (Bite & Sip yellow/black and "CafeFlow" navy/orange), ~40 screens, inventory and finance modules | Kept the Bite & Sip identity and the core QR → menu → cart → track flow. Contradictions resolved in `DESIGN_REVIEW.md`. |
| Existing repository (`saipranav2004/Free`) | Only unrelated zip files (a "PAM" project: `backend.zip`, `frontend.zip`, agent binaries) | Left untouched. Bite & Sip lives in `bite-and-sip/`. |
| Logo (`0b1b0a5d-image.jpg`) | Black disc, white cup and croissant, yellow `#FCC014` accents | The brand yellow was sampled from the logo (most frequent yellow pixel ≈ `#FCC014`). Icons and app icons were generated from it. |

## 2. Reference implementations

None of these was copied. Licenses are noted because they limit reuse.

| Project | Stack (verified from README) | License / activity | Lesson for Bite & Sip |
|---|---|---|---|
| [CampusBite](https://github.com/zs0c131y/CampusBite) | React 18 + Vite + Tailwind v4, Express, **PostgreSQL**, JWT | License not shown; 44 commits, 0 stars | Closest product match: UPI deep links, **manual staff verification** of UPI, store settings hold the UPI ID. It also confirms deep links only work on phones, so desktop needs a QR. We copy the idea, not the code. **Correction:** our earlier summary said MongoDB, but the README says PostgreSQL. |
| [OrderWorder](https://github.com/itzzritik/OrderWorder) | Next.js, MongoDB, NextAuth | License not shown; 138 stars, 152 commits | Unique QR per table, name and phone at checkout, live kitchen dashboard. Confirms no customer accounts are needed. We skipped its AI assistant and payroll as scope creep. |
| [elitale/restro](https://github.com/elitale/restro) | Next.js 16, Prisma/Postgres, Supabase Storage | **AGPL-3.0** (cannot embed code without open-sourcing) | Table passed as `?table=` query param with printable QR codes. Its guests verify by SMS OTP (Twilio), which we deliberately skipped (cost and friction). It is layered (UI → actions → services → repos), and its KDS uses voice alerts, which inspired our chime. |
| [Val Town canteen](https://www.val.town/x/Pratham211/canteen) | React, Hono, SQLite, **polling** | — | Status flow `pending → confirmed → preparing → ready → completed`. The README documents **no admin auth**, an anti-pattern we avoid. Polling-only updates show why we pair realtime with a polling fallback. |
| [CanteenBuddy](https://github.com/hovahyii/CanteenBuddy) | PHP/MySQL + ESP32 LCD | LICENSE present; 8 commits | A "ready for pickup" notification is the core student need. Its hardware is out of scope. |

## 3. Technical sources (primary where possible)

| Topic | Source | Finding | Applied |
|---|---|---|---|
| Keys | [Supabase: Securing your data](https://supabase.com/docs/guides/database/secure-data) | The publishable key is safe in browsers **only with RLS**. Secret/service-role keys bypass RLS and must never be exposed. | Browser uses only `VITE_SUPABASE_PUBLISHABLE_KEY`. The secret key is used only by `scripts/create-staff.mjs` on a trusted machine. |
| RLS | [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) | One policy per command; `to authenticated`; wrap `auth.uid()` in `select`; SECURITY DEFINER helpers in a non-exposed schema with `search_path=''`; **policies don't remove grants**. | All of these are in the migration. Helpers live in `private`. Grants are revoked then re-granted per column. |
| Default grants | Verified locally: `pg_default_acl` grants ALL on new public tables to `anon`/`authenticated` | RLS alone is not enough. | `revoke all …` plus least-privilege column grants, and default privileges revoked for future objects. |
| Realtime | [Supabase: Broadcast](https://supabase.com/docs/guides/realtime/broadcast) | `realtime.send(payload, event, topic, private)`. Public channels can be joined without auth, and DB broadcasts default to private. | Students get a **public** topic named with a random `track_key`, with a payload limited to status fields and no personal data. Staff use Postgres Changes (RLS-checked). Verified by tests, including that non-staff get nothing. |
| UPI link | [NPCI UPI Linking Specification 1.6](https://www.labnol.org/files/linking.pdf) (p.5) | `upi://pay?pa=&pn=&am=&cu=&tn=`. `pa`, `pn` mandatory; `am` decimal; `cu` only INR; `tr` mandatory for *merchant* dynamic links. | We send `pa, pn, am (55.00), cu=INR, tn`. `tr` is omitted because most cafés use a personal/BHIM VPA. Owners should test with their own app (see `DEPLOYMENT.md`). |
| UPI verification | [CampusBite UPI docs](https://mintlify.wiki/zs0c131y/CampusBite/features/upi-payments), [Frinext Scan & Pay](https://cn.wordpress.org/plugins/frinextqr/) | Without a gateway, **no free automatic verification exists**. Projects use manual staff confirmation. | "I've paid" only records a *claim*. Only staff can set `paid`. |
| UPI failure modes | [PhonePe PG](https://business.phonepe.com/upi-intent-flow), [technetexperts](https://www.technetexperts.com/fix-upi-limit-exceeded-error/), [EximPe](https://docs.eximpe.com/integration-guide/web-integration/s2s-upi-intent) (all vendor) | Raw intents can hit "risk"/limit errors, and integer amounts break some bank apps. Keep the generic `upi://` scheme as a fallback. | Amount is always formatted `55.00`. We use the generic scheme only. A QR is always shown alongside the button. These limitations are documented. |
| Free tier | [automationatlas](https://automationatlas.io/answers/supabase-free-tier-limits-2026/), [jetadmin](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) (secondary) | ~200 concurrent realtime connections, 500 MB DB, projects pause after 1 week idle on Free. | Fine for one café. Holiday pausing is documented in operations notes. Verify on supabase.com/pricing. |

## 4. UI / UX research: yellow-and-black design

**Question:** what does a great yellow-and-black ordering interface look like, and which patterns should we use?

### 4.1 Template search (honest result)
- Searches of Dribbble, Behance, Figma Community, ThemeForest/TemplateMonster and 2026 restaurant-template roundups found **no high-quality template that is specifically yellow and black and built for counter-pickup ordering**. Most free food kits ([Figma: Food Ordering App UI Kit](https://www.figma.com/community/file/1233451074887323831/food-ordering-app-ui-kit-free), [Cook UI kit, CC BY 4.0](https://www.figma.com/community/file/1255795628849357440/cook-food-drink-delivery-mobile-app-ui-kit-free-figma-community), [Food App UI Kit, 64 screens](https://www.figma.com/community/file/1017068620457356663/food-app-ui-kit-freebie)) are orange/red delivery apps with couriers, addresses and coupons that we don't need.
- The closest visual reference is the "Tasty Burger" app described by [Mockplus](https://www.mockplus.com/blog/post/food-mobile-app): a **black background with yellow and white type**, chosen to echo the food photography. Dark food apps on Dribbble ([example](https://dribbble.com/shots/15345966-Food-Delivery-App-Dark-Mode)) use a near-black base `#08070A` with a warm accent.
- **Decision:** rather than adopt a generic kit, we built our own system from the café's logo (black disc, yellow accents, white cup). Black is used for **identity surfaces** (header, hero band, cart bar, staff top bar). The menu content sits on a **warm cream canvas**, because long lists of food names and prices read better on light backgrounds. Yellow marks **the one thing to do next**.

### 4.2 Proven patterns from yellow-led products
| Source | Pattern | Applied |
|---|---|---|
| [giffgaff design system](https://giffgaff.design/design-fundamentals/colour-palette) | Yellow is **reserved for primary actions**; red only for alerts and destructive actions; text contrast ≥ 4.5:1 | Yellow = primary buttons, selected state, "Ready" hero, table chip. Red only for cancel, errors and overdue tickets. |
| Blinkit case studies ([1](https://medium.com/design-bootcamp/enhancing-the-user-experience-of-blinkit-app-a-ux-ui-case-study-8bc70ff6a0e4), [2](https://medium.com/@srirammanogar07/understanding-ui-design-by-recreating-the-product-listing-page-of-blinkit-a-case-study-66fff1e951b), [3](https://medium.com/@anshuchoudhary8055/streamlining-the-user-experience-in-blinkit-enhancing-discoverability-and-consistency-in-the-a1c4da00aa86)) | Floating cart bar showing **item count + total**; **high-contrast Add buttons**; sold-out items **greyed with a label**; a snackbar after adding | All four are implemented: black cart bar with a yellow "View cart", Add buttons with an ink border, greyscale art plus a "Sold out" chip, and an "added" toast. |
| [NN/g menu-design checklist](https://www.nngroup.com/articles/menu-design/) | Show the current location; big tap targets; familiar labels; sticky menus on long pages; don't hide navigation on desktop | Selected category chip is filled black with yellow text. Chips are 44 px tall. Labels are plain ("Beverages", "My orders"). Search and categories stick under the header. Staff nav is visible on desktop. |
| [Baymard checkout guide](https://baymard.com/learn/checkout-flow-ux-optimization) | Guest checkout must be the default; no forced accounts; turn off autocorrect on names; correct mobile keyboards | No student login. Name field has autocorrect off. Phone uses `type=tel` with a numeric keyboard and a fixed `+91` prefix. Cart and checkout are a single page with a sticky "Place order" button. |
| KDS guidance ([case study](https://medium.com/@osamahaashir/cooking-up-success-revamping-kitchen-display-system-kds-ux-case-study-6a6c92784fb9), [Fresh KDS](https://www.fresh.technology/blog/kitchen-display-system-features-you-need), vendor) | Ticket timers that escalate **calm → yellow → red**; **don't overuse red**; order number and timer at the top; modifiers must stand out; minimal training | Ticket timer chip: grey, then yellow at 3 min (new) / 12 min (preparing), then red at 5 / 20 min. Notes are highlighted in yellow. Order number is 24 px bold. Each card has one primary action. |

### 4.3 Contrast verification (computed, WCAG 2.x formula)
| Pair | Ratio | Verdict / action |
|---|---|---|
| Ink `#111` on brand yellow `#FCC014` | **11.4 : 1** | AAA, so black-on-yellow is used for all yellow buttons |
| White on brand yellow | 1.65 : 1 | **Fails**, so white text never appears on yellow |
| Yellow `#E5A800` as text on white | 2.1 : 1 | **Fails**. Added `brand-ink #8A5D00` (5.8 : 1) for yellow-family text |
| Muted `#6B6457` on cream | 5.7 : 1 | AA |
| Old subtle `#8F8778` on white | 3.6 : 1 | **Failed**, darkened to `#756D5F` (5.1 : 1) |
| Old ready green `#15803D` on its tint | 4.46 : 1 | **Failed narrowly**, darkened to `#12723A` (5.3 : 1) |
| Input border `#D6CCB8` on white | 1.6 : 1 | **Failed** WCAG 1.4.11, so added `field #8C8270` (3.8 : 1) for control borders |

### 4.4 Limitations
- Most UX sources about food ordering are vendor blogs or student case studies, not controlled studies. We used them for patterns, not numbers.
- We could not access paywalled Baymard food-delivery research. A frequently quoted "58% mobile abandonment" figure could not be traced to Baymard, so it is not used.
- Real food photos will look better than our illustrated fallbacks. The owner can upload photos per item.
