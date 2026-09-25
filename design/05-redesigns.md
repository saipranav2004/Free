# Phase 5 + 6 — Per-page redesigns, with responsive & cross-browser spec

> **Pass 2 addendum.** This document covers the 24 routes. The 44 secondary
> surfaces they open — modals, confirmations, wizards, menus, the recording
> player, toasts — are enumerated in [`06-surface-tree.md`](06-surface-tree.md)
> and were built in revision 2. The list-chrome and density changes that
> revision made to *these* pages are in [`07-critique.md`](07-critique.md);
> where this document and the mockups disagree, the mockups are current.

Every page below follows the same format:

> **Layout** (structure first) · **What changed and why** (traced to Phase 2
> research and Phase 3 personas) · **Component-level fixes** · **Role
> variants** · **Every action → its endpoint** · **Requires backend support**
> · **Responsive** (mobile / tablet / desktop / ultrawide) · **Chrome & Edge**

Mockups live in `design/mockups` (React + Vite). `npm install && npm run dev`,
then use the **Viewing as: User / Admin / Root** switch in the top bar — that
switch is a mockup affordance for reviewing role branches, not a proposed
feature.

---

## Cross-cutting responsive rules (asserted, not assumed)

These hold on every page and are verified in the mockups at 390 / 820 / 1280 /
1920 px:

| Breakpoint | Shell | Tables | Actions |
|---|---|---|---|
| **≤767 (mobile, 390–428)** | Sidebar → off-canvas drawer over a scrim, opened from a 44×44 hamburger; closes on navigate | Horizontal scroll **inside the table container**, first column(s) frozen with an opaque background + edge divider; page body never scrolls sideways | Row actions always visible (no hover on touch); every tap target ≥44px; filter chips wrap |
| **768–1279 (tablet)** | Sidebar → 56px icon rail with tooltips; user can expand (persisted) | Same table, more columns visible | Hover actions return |
| **1280–1440 (desktop)** | Sidebar expanded, 240px, persistent | Essential columns fit without scroll (column widths in `ui/table.jsx` are sized against the 1136px content area a 1440px viewport leaves) | Contextual toolbars |
| **≥1600 (ultrawide)** | Content **caps at 1440px and centres**. Never full-bleed | Table stops growing with the viewport; the gutter grows instead | — |

Measured horizontal page overflow at every one of those widths, on `/` and
`/sessions`: **0px** (the −10px reading is the reserved scrollbar gutter).

**Chrome & Edge.** Both are Chromium, so the real risks are the two places
they can still differ from each other or from a user's settings:

1. **Scrollbar gutter.** `html { scrollbar-gutter: stable }` reserves the
   gutter unconditionally, so a page that grows past the fold does not shift
   horizontally, and a Chrome window with overlay scrollbars enabled lays out
   identically to an Edge window without them. The current build already does
   this and it is kept.
2. **Font smoothing.** `-webkit-font-smoothing: antialiased` +
   `-moz-osx-font-smoothing: grayscale` set once on `body`, so weight does not
   shift between the two on macOS.
3. **No browser-specific CSS anywhere.** No `-webkit-`-only layout, no
   `-ms-` anything, no `@supports` forks. `::-webkit-scrollbar` is styled but
   is purely cosmetic and degrades to the platform scrollbar.
4. **Root font-size is the browser default (16px).** The current build's
   `14.5px` root plus two breakpoint steps means every rem value differs
   between a default Chrome and a user who has changed their default size, and
   changes again at 1800px and 2400px. Returning to 16px removes an entire
   class of "it looks different in Edge" reports whose actual cause is a
   different default font size, not a different engine.
5. **Edge-specific chrome to test for:** the Edge sidebar/Copilot pane
   narrows the viewport without a resize of the OS window — the layout is
   fluid down to 320px, so this is covered by the mobile breakpoint rather
   than a special case.

---

## 1. `/` Dashboard

**Layout**

```
┌───────────────────────────────────────────────────────────────┐
│ Control plane                        updated 4s ago · polls 15s│
│ What is waiting on a decision, and what is live right now.     │
├───────────────────────────────────────────────────────────────┤
│ ▲ 1 break-glass grant in force …                    [Review]  │  ← only when > 0
├───────────────────────────────────────────────────────────────┤
│ WAITING ON YOUR DECISION                                       │
│ 7                                        [ Open the queue → ]  │  ← 28px, the only display-size number
│ 4 new · 3 need a second approver · includes break-glass         │
│ ─────────────────────────────────────────────────────────────  │
│ ACTIVE SESSIONS 12  ACTIVE GRANTS 23  RESOURCES 34  BREAK-GLASS 1│  ← flat stat rail
├───────────────────────────────────────────────────────────────┤
│ The queue                                            All 7 →   │
│ ┌ resource · requester · duration · ticket · reason ─────────┐ │
│ │  … 1 of 2 approved   [Approve (2 of 2)] [Deny]             │ │
│ └────────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────┤
│ Activity                                                       │
│  events/hour bar chart      │  recent denials list             │
│  most active accounts (bar list)                               │
└───────────────────────────────────────────────────────────────┘
```

**What changed and why**

- **The 5-cell KPI strip is gone.** Only one of those five numbers is a
  decision (`pending_approvals`); one is an alarm (`active_breakglass_grants`);
  three are inventory. Datadog's service pages and Okta's admin home both lead
  with the thing you must act on. Hierarchy now says which is which.
- **The greeting is deleted.** "Good to see you, root" occupied the position of
  highest visual authority on a security console and carried no information.
- **The queue is inline under the hero**, not in a card beside another card:
  the number and the work it refers to are one object. This is Teleport's
  "Needs Review" and Okta's task-first landing page.
- **The break-glass alarm only renders when non-zero.** A permanent "0
  break-glass" tile trains people to stop reading the row it lives in.
- **Freshness is stated** ("updated 4s ago · polls every 15s") because the
  backend has no push channel and pretending otherwise is a lie a live console
  cannot afford. Datadog Live Processes does the same.

**Component-level fixes**

| Was | Now |
|---|---|
| `Masthead` = greeting + `KpiStrip` of 5 `KpiCell`s | `HeroMetric` (one) + `StatRail` (flat, no box) |
| Attention cards in a 2-col grid, each `Card` bordered + shadowed | One `Panel` (hairline) with the queue rows in it |
| `AreaChart` + `DonutChart` + `BarList` in three `Card`s | One bar chart (events/hour, denials stacked in `--danger`), one denial list, one bar list — all flat, no boxes |
| `AdminShortcuts` link grid | Removed. It duplicated the sidebar; the queue is the shortcut that matters |

**Role variants**

- **Admin / Root** — one view. Root differs by the Approve label
  (`Approve (final)`) and its consequence line, both already produced by
  `lib/fourEyes.js`. No third dashboard.
- **Normal User** — genuinely different job, so a different composition: hero
  is the **soonest-expiring grant with a live countdown**; stat rail is grants
  / requests-in-flight / open sessions; sections are active access, requests
  waiting on an approver, and **their own** recent activity.

**Every action → endpoint**

| Control | Endpoint |
|---|---|
| Approve | `POST /pam/admin/actions/jit-requests/:id/approve` (MFA-gated) |
| Deny | `POST /pam/admin/actions/jit-requests/:id/deny` |
| Metrics | `GET /pam/admin/stats` |
| Queue | `GET /pam/admin/jit-requests?status=PENDING` and `…=PARTIALLY_APPROVED` (two calls — the endpoint filters one status at a time) |
| Activity | `GET /pam/admin/audit` (paged) · user branch: `GET /pam/audit?user_id=<me>` |
| User grants / requests / sessions | `GET /pam/jit/grants`, `GET /pam/jit/requests`, `GET /pam/sessions/mine` |

**Requires backend support**

1. **Any trend at all.** `GET /admin/stats` returns point-in-time counts with
   no history, so no delta, arrow or sparkline is drawable. A
   `?compare=24h` or a `/stats/history` would let one hero metric carry a trend
   — which is the single highest-value addition on this page.
2. **A combined open-queue filter.** Rendering the queue costs two requests
   because `status` takes one value; `status=PENDING,PARTIALLY_APPROVED` would
   halve it.
3. **`awaiting_first_approval` / `awaiting_second_approval`** — the UI already
   reads them behind a null guard and the supplied backend snapshot doesn't
   return them. Confirm they exist in the deployed API.

**Responsive** — mobile: hero + caption stack, the action button goes
full-width under the caption; the stat rail wraps to two rows; queue rows
become two-line stacks with the two buttons on their own row (44px targets);
the bar chart keeps 12 bars but drops to 48px tall. Tablet: hero and action on
one line, activity zone becomes a single column. Desktop: as drawn. Ultrawide:
content caps at 1440 — the chart does not stretch.

**Chrome & Edge** — the bar chart is flex + percentage heights, no canvas, no
SVG viewBox rounding; identical in both. The pulse dot uses `transform` only.

---

## 2. `/resources`

**Layout** — page header (title + one primary `Add resource` for admins) →
one filter row (search · JIT required · Always recorded · No credential ·
count · table/grid toggle) → dense table with a frozen name column and one
verb per row.

**What changed and why**

- **Card grid → table by default.** `PAMResource` exposes eight comparative
  fields; cards force three-per-row and destroy column alignment, which is the
  only thing that makes a 30-row estate scannable. Teleport and StrongDM both
  present the catalog as a dense list with one right-aligned verb.
- **`requires_jit` / `always_record` / "no credential" become facets.** They
  were badges you had to read row-by-row; they are what an operator actually
  navigates by ("show me everything JIT-gated", "show me what has no
  credential stored").
- **One verb per row, and it explains itself**: `Connect` ·
  `Request access` (when `requires_jit`) · disabled `No credential` (when
  `vault_entry_id` is null) · disabled `Inactive` (when `is_active` is false).
  All four states come from real fields.
- **The type glyph stays** — it encodes `resource_type`. The decorative icons
  beside card titles do not.

**Component-level fixes** — `ResourceCard` grid retired as the default (kept
behind an explicit toggle, borderless, no hover-lift); `SegmentedControl` for
view mode moves to the right of the filter row where it belongs;
`RESOURCE_COLUMNS` gains a Controls column that merges the two boolean flags.

**Role variants** — one view. The `No credential` facet and `Add resource`
render for admin/root only, because `POST/DELETE /admin/resources` is
`RequireAdmin`. Root ≡ Admin here; there is no root-only resource endpoint.

**Endpoints** — `GET /pam/resources/groups` (list), `POST
/pam/admin/resources` (create), row verb → `POST /pam/resources/:id/sessions`
or `POST /pam/resources/:id/launch`.

**Requires backend support** — resource **update**. `POST` and `DELETE` exist;
there is no `PATCH /admin/resources/:id`, so "rename this resource" or "turn
`requires_jit` on" is delete-and-recreate today. No edit control is mocked.

**Responsive** — mobile: filter chips wrap to two rows; table scrolls
horizontally with the name column frozen; the grid toggle defaults to grid
below 640px because a single large touch target beats a 6-column scroll on a
phone (this is the one sanctioned card-per-row in the system). Tablet: table,
Controls and Credential columns visible. Ultrawide: capped.

---

## 3. `/resources/:id`

**Layout** — header (type glyph + name + description, **Connect as the page's
primary action**) → JIT notice band when `requires_jit` → `Connection` and
`Controls` as two-column detail lists → Sessions → Audit → a separated
**Administration** zone below a rule (admin only).

**What changed and why** — Connect was a card among cards; it is the reason
the page exists, so it moves to the header (Teleport's resource view). The
four tabs collapse to one scrolling page with ruled labels, so every section
is deep-linkable and nothing hides behind a click you have to guess at
(Entra's blade model). Admin management is separated from use, the way
CyberArk separates "use this account" from "administer this account".

**Role variants** — Normal User sees everything except the Administration
zone. Admin ≡ Root.

**Endpoints** — `GET /pam/resources/:id`, `GET /…/connect-info`, `POST
/…/sessions`, `POST /…/launch`, `GET /pam/audit/resource/pam:resource/{id}`,
and (admin) `POST /admin/resources/:id/credential`, `/rotate`, `DELETE
/admin/resources/:id`.

**Requires backend support** — sessions *for this resource* are filtered
client-side from `GET /admin/sessions`; a `resource_id` filter on that endpoint
would make the section correct for a Normal User too (today they can only see
their own).

**Responsive** — mobile: header actions stack full-width; detail lists go
one-column; Administration stays last so a destructive button is never the
first thing under a thumb. Ultrawide: detail lists cap at two columns rather
than spreading to four.

---

## 4. `/vault` (safes)

**Layout** — header + `New safe` → search → table (Safe · Description ·
Credentials · Retention · Created).

**What changed** — card grid → table. A `Safe` has four attributes; a card is
five times the height of the line it needs. Credential count is a real derived
value from `GET /safes/:id/credentials`, not an invented metric — if that call
is not made on the list, the column is omitted rather than guessed.

**Role variants** — none. The OPA bundle grants `pam:vault:*` to the `user`
role on `*`, so all three roles see the same vault. This is the page where the
usual "admins see more" assumption is most wrong.

**Endpoints** — `GET /pam/safes`, `POST /pam/safes`.

**Requires backend support** — a credential count on `GET /pam/safes` (today
it needs one call per safe), and safe **update/delete** (neither exists).

**Responsive** — mobile: Description and Retention columns scroll out, Safe
column frozen. Ultrawide: capped.

---

## 5. `/vault/:safeId`

**Layout** — header → **path breadcrumb** (`production / prod-databases /
postgres`) → one table mixing folders (navigate) and credentials (open), with
Reveal as the row action.

**What changed and why** — `models.Folder` returns `path`
(`/prod-databases/postgres`) and the current UI fetches it and throws it away,
rendering two flat lists side by side. HashiCorp Vault's path-first navigation
is free here and is how people address a secret in code anyway.

**Endpoints** — `GET /pam/safes/:id`, `/folders`, `/credentials`; `POST
/…/folders`, `/credentials`.

**Requires backend support** — none for this layout. (Folder rename/delete
don't exist, so neither is offered.)

**Responsive** — mobile: breadcrumb wraps and stays tappable at 44px per
segment; table frozen on Name. Tablet+: as drawn.

---

## 6. `/vault/:safeId/credentials/:id`

**Layout** — header (path eyebrow, name, `Reveal` as the single primary) →
break-glass alarm when `is_breakglass` → a consequence panel explaining what
Reveal writes to the audit log → **Rotation section first** → Details →
Version history.

**What changed and why** — AWS Secrets Manager leads with rotation state and
puts the value behind a deliberate reveal; ours already returns `version`,
`last_rotated_at`, `next_rotation_at` and `rotation_interval_days` and barely
shows them. The consequence sentence sits at the point of the action rather
than in a tooltip, which is how Vault and 1Password Business explain audited
access. Overdue rotation (`next_rotation_at` in the past) gets an amber band —
a real comparison of two real fields, not a derived score.

**Component-level fixes** — 4 stacked `Card`s → 3 flat sections; the three
write operations are labelled with their *different blast radii*
("store a new version" records what the vault knows; "change the password on
the target" also pushes to the resource) because they are different endpoints
and the current UI presents them as peers.

**Endpoints** — `GET /pam/credentials/:id`; `POST /…/reveal` (reason
required), `/versions`, `/password-change`, `/rotate`.

**Requires backend support** — there is no credential **delete** endpoint, so
no delete control is offered. Version history is rendered from what
`/versions` writes; if `GET /credentials/:id` does not return the version list,
that section needs a `GET /credentials/:id/versions`.

**Responsive** — mobile: Reveal becomes a full-width primary directly under
the title; detail lists one-column. Ultrawide: capped, detail lists stay
two-column.

---

## 7. `/sessions`

**Layout** — header + freshness marker → filter row (`Everyone|Mine` for
admins · Live now · Unrecorded · Break-glass · count) → dense table, frozen
checkbox + resource columns → per-row End / Kill → drawer for detail.

**What changed and why**

- **KPI strip removed; its numbers became the filter chips.** Same counts, and
  now clicking one asks a question instead of just reporting.
- **`Unrecorded` is the important new facet.** A live session where
  `recording_required` is true and `recording_id` is null is a privileged
  connection with no tape — the one row on this page worth interrupting
  someone for. The current build can only find it by eye.
- **Mine/All stops being a control a Normal User has to understand.** They
  have exactly one scope (`GET /sessions/mine`), so the switch does not render
  for them.
- **Liveness is honest**: "updated 4s ago · polls every 15s", driven by the
  existing `SESSIONS_POLL_MS`.
- **Bulk selection reports per-item results.** There is no bulk endpoint, so
  the bar says so and the outcome is "14 of 17 killed · 3 failed", never one
  success toast implying atomicity.

**Role variants** — Normal User: same table minus User, minus Kill, minus the
scope switch, minus the admin facets. Admin ≡ Root.

**Endpoints** — `GET /pam/sessions/mine`, `GET /pam/admin/sessions`, `POST
/pam/sessions/:id/end`, `POST /pam/admin/actions/sessions/:id/kill` (reason
required).

**Requires backend support**

1. **A push channel.** 15s polling is the current ceiling; SSE or a websocket
   would make this page genuinely live.
2. **Server-side filters** for `is_breakglass` / `recording_required` /
   `status` on `GET /admin/sessions` — the facets are client-side over a page
   of results today, so "unrecorded" is only accurate within the fetched page.
3. **A bulk kill endpoint**, if bulk termination is ever a real requirement.

**Responsive** — mobile: chips wrap; table scrolls with checkbox + resource
frozen (verified); row actions always visible; the bulk bar becomes a sticky
bottom bar. Tablet: Source IP and Duration visible. Desktop: all columns fit.
Ultrawide: capped.

**Chrome & Edge** — the frozen columns rely on `position: sticky` on `<td>`
with an explicit opaque background, which is the pattern that works in both;
the smearing bug the current build fixed came from `bg-inherit`, and that fix
is carried over verbatim.

---

## 8. `/jit` (self-service)

**Layout** — header (`Request access` primary, `Break-glass` as a quiet
danger action) → **Open** (one lifecycle list) → **History** (collapsed).

**What changed and why** — the two tables merge into one lifecycle list.
`AccessGrant.request_id` and `JITRequest.grant_id` mean the join already exists
in the payload and the current UI ignores it, forcing the user to correlate by
resource name across two paginated tables. Okta Access Requests treats an
approved request as *becoming* the access entry, and that is exactly what our
data says. Every open row states **who it is waiting on**, not just that it is
waiting.

**Role variants** — single-role page. Admin/root are redirected to
`/admin/jit` by `SelfServiceOnly`; the mockup renders the permission-denied
state with a link there rather than a silent bounce.

**Endpoints** — `GET /pam/jit/requests`, `GET /pam/jit/grants`, `POST
/pam/jit/requests`, `POST /pam/jit/breakglass`, `POST
/pam/jit/requests/:id/cancel`.

**Requires backend support** — **extension**. There is no "extend this grant"
endpoint, so the dashboard's "Request an extension" button navigates to the
request form rather than calling something that doesn't exist. A
`POST /jit/grants/:id/extend` would remove a whole re-request cycle.

**Responsive** — mobile: rows become two-line stacks, status line above the
action; History stays collapsed by default. Ultrawide: capped.

---

## 9. `/jit/requests/:id`

**Layout** — header (resource + reason, one contextual action) → live band
when a grant is active → **Progress timeline** (Requested → First approval →
Second approval → Access) → decision reason → Request details → Grant details.

**What changed and why** — the timeline is the page. The current build makes
the approval trail one card among nine, none with more weight. `decision_reason`
is returned and under-shown; Teleport filed issue #48764 asking for exactly
this on their own UI.

**Endpoints** — `GET /pam/jit/requests/:id`, `GET /pam/jit/grants`, `POST
/pam/jit/requests/:id/cancel`.

**Requires backend support** — the requester's own detail endpoint does **not**
return the `approvals` array (only `GET /admin/jit-requests/:id` does), so the
timeline says "approved by one admin" without naming them. Adding `approvals`
to the requester's view — or an explicit "waiting on N more" field — would let
this page name who is next.

**Responsive** — the timeline is a vertical list at every width; detail lists
go one-column below 640px. Ultrawide: capped.

---

## 10. `/admin/jit` → **Approvals**

**Layout**

```
Admin Center
Approvals                                  [ Queue 8 | Grants 4 ]
Standard requests need two different approvers. Root settles alone…
▲ 1 break-glass request in its mandatory waiting period …
[Break-glass only]                    You are approving as m.sharma
── One approval short  3 ─────────────────────────────────────────
   resource · requester · duration · ticket · reason
   approved by m.sharma · needs 1 more · expires in 3h
                                   [Approve (2 of 2)] [Deny]
── New  4 ────────────────────────────────────────────────────────
── Break-glass — waiting period  1 ───────────────────────────────
── Recently decided ──────────────────────────────────────────────
```

**What changed and why** — this is the highest-value screen in a PAM console
and it currently opens as a generic filtered table. It becomes a **queue in
decision order**: one-approval-short first (they need one specific different
person and clear fastest), then new, then break-glass in its waiting period.
Four-eyes state is the *band a request sits in*, so nobody decodes a chip.
Approve/Deny are inline (StrongDM); the drawer is for **why** — the trail, the
justification, the consequence line. A request the viewer already approved
shows the reason it is blocked instead of offering an action the server will
409.

**Role variants** — Admin: `Approve` / `Approve (2 of 2)`. Root:
`Approve (final)` with "your approval issues the grant immediately". Both
labels and the blocked-reason come from `lib/fourEyes.js` unchanged.

**Endpoints** — `GET /pam/admin/jit-requests` (per status), `GET
/pam/admin/jit-requests/:id` (the only source of `approvals`), `GET
/pam/admin/grants`, `POST /…/actions/jit-requests/:id/approve`, `/deny`,
`POST /…/actions/grants/:id/revoke`.

**Requires backend support** — no bulk approve (correctly: four-eyes and bulk
are in tension), and no multi-status filter. Also: the grants tab shows
`sessions_killed` after a revoke because the response returns it; a
*pre-flight* count ("this will kill 2 live sessions") would need the API to
say so before the write.

**Responsive** — mobile: each queue row becomes a stack with the two buttons
on their own 44px row; the band headings stay as sticky-ish separators; the
drawer goes full-screen. Tablet: rows stay two-column. Ultrawide: capped, the
drawer stays 512px.

---

## 11. `/admin/identity`

**Layout** — header + `New user` → search + facets (Privileged · No MFA ·
Not active) → table with the status dot merged into the frozen Account column.

**What changed and why** — facets replace scanning. "Who holds a privileged
role", "who has no MFA" and "who can't sign in" are the three questions this
page is opened for, and none of them was answerable without reading every row.
Okta's People view is exactly this shape. **Bulk selection is deliberately
removed**: no bulk endpoint exists, so a "suspend 12 accounts" button would be
twelve requests with twelve failure modes wearing one button's clothes.

**Endpoints** — `GET /pam/admin/identity/users`, `GET /…/users/:id` (role
hydration), `GET /pam/admin/rbac/roles`.

**Requires backend support** — **roles on the list payload.** `lib/roles.js`
documents that the list may omit roles entirely, so the page fires an extra
request per row to hydrate them. Returning `roles` on `GET
/identity/users` removes an N+1 and a whole class of "shows None" bugs.
Also: server-side search/filter (today `q` is the only server filter).

**Responsive** — mobile: Email and Roles scroll out, Account frozen. Ultrawide:
capped.

---

## 12. `/admin/identity/:id`

**Layout** — header (username + status) → protected/locked bands → Identity →
Access (roles with what each grants; directly attached policies) →
**Administrative delegation** (root-gated, self-explaining) → Activity →
**Account lifecycle** below a rule, split into *reversible* and *irreversible*.

**What changed and why** — this is the most consequential screen in the
product and it is currently a flat wall of ten cards where "edit full name"
and "delete this account" carry the same weight. Okta's profile page separates
lifecycle operations by risk, and GitHub's danger zone is the pattern for the
irreversible half. Root-only controls now **say** they are root-only
(`MinRankToDelegateAdmin = 100`) instead of rendering disabled with no
explanation; `is_protected` explains itself the same way.

**Role variants** — Admin sees the delegation section as an explanation panel;
Root sees the actual control. This is the **only** page where root vs admin is
a real functional difference.

**Endpoints** — as listed in Phase 1, including `POST /users/:id/reset-mfa`
and `POST/DELETE /users/:id/delegate-admin`, `GET /users/:id/delegation`,
`GET /pam/audit/user/:id`.

**Requires backend support**

1. **Effective permissions.** `GET /users/:id` returns *attachments*
   (`access.roles`, `access.policies`), not what they resolve to. AWS IAM's
   "why does this user have this" view is not buildable and is not mocked.
2. **`POST /users/:id/reset-mfa`** is absent from the supplied backend
   snapshot — verify before building.

**Responsive** — mobile: detail lists one-column; the lifecycle zone stays at
the bottom so a destructive control is never the first thing under a thumb;
role rows stack. Ultrawide: capped.

---

## 13. `/admin/roles` · 14. `/admin/policies`

**Layout** — Roles: table + drawer showing *what the role grants* as rule
lines. Policies: a vertical list of policies, each rendered as a monospace
rule block.

**What changed and why** — a policy is a document, and AWS IAM renders it as
statements: `ALLOW  pam:vault:Reveal  ON  pam:vault/*`. Ours renders
`actions[]` and `resources[]` as two rows of badges — the same information at
several times the reading cost. System objects state *why* they are locked
(`root`/`admin`/`user` are seeded and the policy engine needs them) instead of
being greyed silently.

**Role variants** — none. Admin ≡ Root; no root-only RBAC endpoint exists.

**Endpoints** — full CRUD on `/admin/rbac/roles` and `/admin/rbac/policies`,
plus role↔policy attach/detach.

**Requires backend support** — **role membership.** "Who holds this role" has
no endpoint and cannot be answered without walking every user, so the drawer
says so rather than showing a number it cannot compute. A `member_count` on
`GET /rbac/roles` (or `GET /rbac/roles/:id/users`) is the single most useful
addition here — a role's blast radius is what you need before you edit it.

**Responsive** — Roles table frozen on Role; the policy rule blocks scroll
horizontally inside their own container on narrow screens (the rules are
monospace and must not wrap). Ultrawide: rule blocks cap at the prose width.

---

## 15. `/admin/mfa-policy`

**Layout** — header → **hero: "Would be locked out if every rule enforced
now"** → stat rail → alarm band → **Impact table** (per account) → Rules table
→ note on which roles have no rule.

**What changed and why** — the clearest "the API already returns more than the
UI shows" case in the audit. `GET /admin/mfa-policy/compliance` already
answers *who would be locked out*, which is Entra Conditional Access's impact
preview, and it currently sits below the rule editor. The page inverts: the
consequence is the page, the editor is what you scroll to once you've decided.

One correctness detail the mockup enforces: at-risk counts are attributed to a
rule **only when that rule actually gates** (`enforce` or `grace`) — counting
them against a `monitor` rule would be a false alarm.

**Role variants** — none (writes are admin-or-root, per `api/mfaPolicy.js`).

**Endpoints** — `GET /admin/mfa-policy`, `GET /…/compliance`, `PUT/DELETE
/…/rules/:roleName`.

**Requires backend support** — **all four of these endpoints are absent from
the supplied backend snapshot.** The page therefore also ships a *degraded*
state (previewable from the header in the mockup) so a deployment that
predates them says "MFA policy isn't available on this deployment" rather than
rendering a red error. There is also **no notification endpoint**, so there is
no "notify the affected users" button — the action is `Review these accounts`,
which is navigation to a page that exists.

**Responsive** — mobile: hero stacks, both tables frozen on the first column.
Ultrawide: capped.

---

## 16. `/activity` (was the orphaned `/audit`)

**Layout** — header → a panel stating the scope → Datadog-style split: facet
rail left (free text, Category, Outcome), dense event stream right, drawer for
one event.

**What changed and why** — fixes **two** findings at once. F-01: `/audit` was
routed but commented out of the nav, so the page was live and unreachable.
F-03: `fetchSelfAuditSample` and the page itself never send `user_id`, and the
backend handler doesn't scope by caller either, so "your activity" renders the
whole organisation's events. This view sends `user_id=<me>` — a parameter the
endpoint already accepts — and says so on the page.

**Role variants** — all three roles get the same self-scoped view.

**Endpoints** — `GET /pam/audit?user_id=…&q=…&category=…&outcome=…&from=…&to=…&limit=…&offset=…` (all real query params), `POST /pam/audit/report`.

**Requires backend support** — **server-side scoping.** A client-side
`user_id` filter is a UI honesty fix, not a security control: the seeded
`user` role holds `pam:audit:Read` on `*` and the handler does not scope, so a
normal user can still query the org-wide trail directly. Either scope
`GET /pam/audit` to the caller unless they hold admin/root, or narrow the
`standard-user-access` policy's `pam:audit:Read` resource from `*` to the
caller's own subtree. **This is a security decision, not a design one, and it
is the most important item on this whole list.**

**Responsive** — mobile: the facet rail moves above the stream as a wrapping
chip row; stream frozen on Action. Ultrawide: rail stays 208px, stream caps.

---

## 17. `/admin/audit`

**Layout** — header with Events / Recordings toggle → same facet-rail search
(org scope, with an Actor column) → Recordings as a table with duration, size,
and the SHA-256 integrity hash.

**What changed and why** — the current page does four jobs behind two tabs.
Events and Recordings stay (they're both "search the past"); chain
verification and report generation move to `/admin/compliance`, because they
are a different user on a different day — an auditor, not an operator. The
facet rail is Datadog's Logs Explorer: filtering never moves the results.
Recordings follow Teleport's model — a searchable archive with the integrity
hash visible, so a recording can be proved unmodified independently of the
audit chain.

**Endpoints** — `GET /pam/admin/audit`, `GET /pam/admin/recordings`.

**Requires backend support** — a playback endpoint. The recordings list
returns `storage_bucket` / `storage_key` / `format: asciicast`; the existing
1265-line `SessionRecordingViewer` is kept as-is, but nothing in the client API
layer fetches the cast file itself — confirm how it is served before wiring
Play.

**Responsive** — as `/activity`. Recordings table frozen on Resource.

---

## 18. `/admin/compliance` *(new route, no new endpoint)*

**Layout** — header → **hero: chain Intact / Broken**, with entries checked and
the sequence range → stat rail → "How this works" → Reports (date range +
generate) → Break-glass register.

**What changed and why** — `AuditLog` carries `prev_hash`, `entry_hash`,
`hash_version` and `sequence_number`, and `GET /admin/audit/verify` returns a
real verification. That is genuine tamper evidence and it is currently a
button inside a tab. CyberArk treats the integrity claim as a compliance
headline, and it is the property that makes this console usable as evidence.
The break-glass register (`GET /admin/breakglass`, `GET
/admin/breakglass/:grant_id/report`) surfaces here too — two endpoints an
incident review always asks for and that the current console barely exposes.

**Role variants** — none.

**Endpoints** — `GET /pam/admin/audit/verify`, `POST /pam/audit/report`
(MFA-gated), `GET /pam/admin/breakglass`, `GET
/pam/admin/breakglass/:grant_id/report`.

**Requires backend support** — report **status**. `POST /audit/report` returns
a file; a long window is a long request with no progress. An async
job + poll would make large exports usable. (Not mocked as async — the mockup
matches today's synchronous contract.)

**Responsive** — mobile: hero stacks, the date inputs go one-column. Ultrawide:
capped.

---

## 19. `/admin/vault-ops`

**Layout** — header → **Backup** (routine, one primary) → a note explaining
why there is no backup history → below a rule: **Restore**, with a
consequence band, the object-key field, and a typed confirmation.

**What changed and why** — backup and restore are currently two equal cards.
Restore replaces the entire vault. AWS Backup / RDS restore state the blast
radius before the button is live, and that is what this does. **Backup history
is not shown**: `POST /vault/backup` returns a key and nothing enumerates
keys — showing an invented list would be worse than showing none.

**Role variants** — none, and that is itself a finding: `POST
/admin/vault/restore` is `RequireAdmin`, not root. Given what it does,
root-only would be the safer contract. That is raised in the UI copy as a
backend decision rather than faked by hiding a button from admins who can
still call the endpoint directly.

**Requires backend support** — `GET /admin/vault/backups` (list), and a
root-only gate on restore.

**Responsive** — single column at every width; the confirmation input caps at
the prose width. Ultrawide: capped.

---

## 20. `/settings`

**Layout** — Profile (read-only detail list) → Multi-factor authentication
(rows) → Desktop agent (device list) → Appearance.

**What changed and why** — nine `Card`s (plus five inside `MfaEnrollment`)
become four sections of **rows**: label left, control right, explanation under
the label. That is the Stripe/Linear settings shape, and `SettingRow` +
`Switch` in the current build already want to be exactly that before each gets
wrapped in a card.

**Role variants** — none. `/auth/me` and the MFA endpoints are identical for
every role; the role badge is data, not a variant.

**Endpoints** — `GET /auth/me`, `POST /auth/mfa/setup/initiate`, `/verify`,
`POST /auth/mfa/backup-codes/regenerate` ⚠, `GET/DELETE /pam/agent/devices`,
`POST /pam/agent/pair/init` (MFA-gated).

**Requires backend support** — `POST /auth/mfa/backup-codes/regenerate` is
absent from the supplied backend snapshot; verify. There is also no
"change my own password" endpoint — a password change today goes through an
administrator (`POST /admin/identity/users/:id/reset-password`), which is worth
a product decision, and no self-service control is mocked.

**Responsive** — rows stack label-over-control below 640px with 44px controls.
Ultrawide: capped, content stays at prose width.

---

## 21. `/login` · 22. `/mfa-verify`

**Layout** — one centred 352px frame on the token background: wordmark, title,
one sentence, the form, one full-width primary, a footer line. Identical frame
for both steps.

**What changed and why** — the split marketing hero used a second hard-coded
palette (`slate-900`/`white`) and 44–68px display type that exists nowhere else
in the product, so a user's first two screens didn't look like the product.
Stripe, Vercel and Okta all sign you in on a quiet centred frame. Reusing the
identical frame for the MFA step makes `/login → /mfa-verify` a content swap
rather than a page change (1Password's unlock model), and the MFA step finally
gets a route back — today the only way out is browser Back.

**Endpoints** — `POST /api/v1/auth/login`, `POST /api/v1/auth/mfa/verify`.

**Requires backend support** — none. (There is a `refresh_token` issued with
no redemption endpoint; the current store deliberately ignores it, and so does
this design.)

**Responsive** — the frame is fluid to 320px; the six OTP inputs are 44px tall
and flex to fill. Ultrawide: the frame stays 352px and centres — it must not
grow.

---

## 23. `404` · 24. Permission denied

**404** distinguishes itself from a permission failure in copy, because those
are different problems and the current console conflates them by redirecting.

**Permission denied** is the new mandatory state (Phase 4.7): a lock glyph,
"You don't have access to X", **the requirement named** ("This needs the `root`
role"), a route the viewer *can* use, and **no Retry button**. It replaces
`AdminRoute`'s silent `<Navigate to="/" />` and `QueryState`'s "Couldn't load
this data" + Retry on a 403. Reviewable at `/denied` in the mockups.

---

## Consolidated "Requires backend support"

Ordered by value, so this doubles as a backend backlog.

| # | Capability | Unblocks | Where |
|---|---|---|---|
| 1 | **Scope `GET /pam/audit` to the caller** unless admin/root — or narrow `standard-user-access`'s `pam:audit:Read` from `*` | A normal user currently reads the whole org's audit trail | `/activity`, dashboard |
| 2 | Roles on `GET /admin/identity/users` | Removes an N+1 per page and the "shows None" class of bugs | `/admin/identity` |
| 3 | Role membership count / `GET /rbac/roles/:id/users` | A role's blast radius before you edit it | `/admin/roles` |
| 4 | History or a comparison window on `GET /admin/stats` | The only way any metric in the product can carry a trend | dashboard |
| 5 | Server-side filters on `GET /admin/sessions` (`status`, `is_breakglass`, `recording_required`) | "Unrecorded privileged sessions" accurate beyond one page | `/sessions` |
| 6 | Multi-status filter on `GET /admin/jit-requests` | Halves the queue's request count | dashboard, `/admin/jit` |
| 7 | `approvals` on the requester's `GET /jit/requests/:id` | The requester can see who they are waiting on | `/jit/requests/:id` |
| 8 | `PATCH /admin/resources/:id` | Editing a resource without delete-and-recreate | `/resources/:id` |
| 9 | `GET /admin/vault/backups` | A restore you can pick from instead of pasting a key | `/admin/vault-ops` |
| 10 | Root-only gate on `POST /admin/vault/restore` | Matches the blast radius to the authority | `/admin/vault-ops` |
| 11 | `POST /jit/grants/:id/extend` | Removes a full re-request cycle | `/jit` |
| 12 | Push channel (SSE/WS) for sessions | Genuinely live, instead of 15s polling | `/sessions`, dashboard |
| 13 | Async report jobs for `POST /audit/report` | Large exports without a hanging request | `/admin/compliance` |
| 14 | Self-service password change | Today it needs an administrator | `/settings` |
| 15 | Confirm the six skew endpoints exist (`mfa-policy` ×4, `reset-mfa`, `backup-codes/regenerate`) | Three pages depend on them | `/admin/mfa-policy`, `/admin/identity/:id`, `/settings` |
| 16 | Bulk endpoints — **only if** bulk is a real requirement | Would let the bulk bar promise atomicity honestly | `/sessions`, `/admin/identity` |

Nothing in the mockups depends on any of these. Every one is listed because
the design deliberately **did not** invent it.
