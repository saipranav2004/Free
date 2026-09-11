# Phase 3 — Personas, verified against the code's actual guards

## 3.0 What the code actually enforces (not what we assume)

Before any persona reasoning, here is the enforcement model as it exists,
read out of both zips. Several common PAM assumptions are **wrong** for this
product and the design must follow the code, not the textbook.

### Route-level

| Layer | What it checks | Where |
|---|---|---|
| `ProtectedRoute` | authenticated (token present, not expired) | `components/auth/ProtectedRoute.jsx` |
| `AdminRoute` | `roles` includes `admin` **or** `root` | `components/auth/AdminRoute.jsx` |
| `SelfServiceOnly` | *not* admin — admins are redirected off `/jit` to `/admin/jit` | `App.jsx` |
| `middleware.RequireAdmin` | `roles` claim includes `admin` **or** `root`; gates the **entire** `/api/v1/pam/admin/*` group | `internal/middleware/admin.go` |
| `middleware.RequirePermission` | OPA decision on `(action, resource)` for the caller's roles | `internal/middleware/authz.go`, wired per-route in `main.go` |
| `middleware.RequireMFA` | caller has a verified MFA factor on this session | on `POST …/approve`, `POST /audit/report`, `POST /agent/pair/init` |

**There is no root-only route group.** Not one. `root` and `admin` reach
exactly the same endpoints at the router.

### Service-level — where root actually differs

Root's extra authority is enforced *inside services*, not at the router:

| Root-only capability | Enforcement | Evidence |
|---|---|---|
| Grant the `admin` role | `MinRankToDelegateAdmin = 100` (root rank 100, admin 80) | `services/identity_delegation.go` |
| Revoke an admin delegation | same rank check | same file |
| Assigning `admin`/`root` via plain `AssignRole` is **blocked for everyone** | `AssertCanAssignRole` — admin must go through `delegate-admin`; `root` cannot be assigned through the API at all | same file |
| Settle a four-eyes JIT request alone | root approval short-circuits the 2-approver requirement | `lib/fourEyes.js` + `APPROVER_RANK`, server-side quorum |
| Modify a protected account | blocked: `is_protected` accounts (the seeded root) cannot be suspended, deleted, or delegated over — **including by root** | `identity_service.go`, `identity_delegation.go` |

So the honest sentence is: **root is an admin plus delegation authority plus
final-approval authority.** Root is *not* a separate console. Designing two
whole navigation trees for root would be inventing a distinction the backend
does not make.

### Normal User — what they can actually see

The seeded `user` role's OPA policy (`opa/policies/default_bundle.json`,
`standard-user-access`) grants, on resource `"*"`:

```
pam:resource:List   pam:resource:Read   pam:resource:Connect
pam:session:Start   pam:session:End
pam:vault:List      pam:vault:Read      pam:vault:Create
pam:vault:Store     pam:vault:Reveal    pam:vault:Rotate
pam:jit:Request     pam:jit:Cancel
pam:audit:Read      pam:report:Generate
```

Two consequences that contradict the standard assumption:

1. **A Normal User has org-wide audit read.** `pam:audit:Read` on `*`, and
   `AuditHandler.Search` does not scope to the caller. So the textbook
   "Normal User has no visibility into other users' data" is **false here**
   (finding F-03). The UI's only mitigation is that `/audit` was removed from
   the nav — a hidden route, not a permission.
2. **A Normal User can generate compliance reports** (`pam:report:Generate`,
   MFA-gated). That is a real capability the UI exposes on `/audit` — which
   they can't navigate to.

The design cannot fix a policy bundle. What it *can* do, and what these
mockups do:

- Scope the Normal User's "my activity" views **client-side** by
  `user_id` — using `GET /pam/audit?user_id=<me>`, a parameter the endpoint
  already supports. That makes the label honest today.
- Raise the org-wide exposure as a **Requires-backend-support** item, because
  a client-side filter is a UI honesty fix, not a security control.

### Role → surface matrix, as enforced today

| Surface | Normal User | Admin | Root |
|---|---|---|---|
| `/`, `/resources`, `/vault`, `/sessions`, `/settings` | ✅ | ✅ | ✅ |
| `/jit` (self-service) | ✅ | redirected → `/admin/jit` | redirected → `/admin/jit` |
| `/audit` | ✅ *(reachable by URL only; returns org-wide data)* | ✅ | ✅ |
| `/admin/*` | ❌ (silent redirect to `/`) | ✅ | ✅ |
| Approve a JIT request | ❌ | ✅ (1 of 2, MFA required) | ✅ (final, alone) |
| Delegate / revoke admin | ❌ | ❌ | ✅ |
| Modify a protected account | ❌ | ❌ | ❌ |
| `GET /sessions/mine` vs `GET /admin/sessions` | mine only | both | both |

---

## 3.1 Per-page persona matrices

Format per page: what each role is trying to do in the **first 5 seconds**,
what must be visible immediately, what gets tucked away, and whether the page
needs separate views or one conditional view.

---

### `/` Dashboard

| | First 5 seconds | Immediately visible | Secondary / tucked | Hidden or absent |
|---|---|---|---|---|
| **Normal User** | "Do I still have access, and is anything about to expire?" | Soonest-expiring grant with a live countdown; requests still in flight and who they wait on | Full grant history, own audit trail, active sessions detail | Org stats, approval queue, break-glass counters, other users' anything |
| **Admin** | "What is waiting on my decision, and is anything on fire?" | Pending-approval count as the hero **with the queue inline**; break-glass alarm band when non-zero | Inventory rail (sessions / grants / resources); activity analysis; admin shortcuts | Self-service request controls (they don't request against themselves — `SelfServiceOnly` already enforces this) |
| **Root** | Same as Admin, **plus**: "is there an elevation I should not have to approve twice?" | Same, but Approve reads **"Approve (final)"** because root settles alone (`lib/fourEyes.js` already returns this label) | Same as Admin, plus delegation entry point | Nothing extra hidden |

**Verdict: one view with two branches, not three.** Admin and Root differ by
*one button label and one consequence sentence*, both already computed by
`lib/fourEyes.js`. Building a third dashboard for root would be inventing a
distinction the backend doesn't make. The User/Admin split already exists in
`DashboardPage.jsx` (`UserDashboard` / `AdminDashboard`) and is correct —
these are genuinely different jobs.

---

### `/resources`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | "Which box do I need, and can I connect right now?" | Name, type glyph, host:port, and a per-row **Connect** state: connect now / requires JIT / no credential | Description, groups, `connect_mode` | Create / delete resource, store & rotate credential (admin endpoints) |
| **Admin** | "Is the estate configured correctly?" | Same list **plus** credential state (`vault_entry_id` present?), `requires_jit`, `always_record`, `is_active` as **facets** | Per-resource management actions on the detail page | — |
| **Root** | Identical to Admin | Identical | Identical | — |

**Verdict: one view, conditional columns and facets.** Root ≡ Admin here —
`POST/DELETE /admin/resources` is `RequireAdmin`, not root.

---

### `/resources/:id`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | "Connect." | The connect affordance and whether it's available; if JIT-gated, a direct route to request | Overview facts, own sessions on this resource | Store credential, rotate, delete; policies tab (admin cross-reference) |
| **Admin** | "Connect, or fix its configuration." | Connect **and** a clearly separated management zone: credential state, rotate, delete | Audit for this resource (`GET /audit/resource/*`), sessions | — |
| **Root** | Identical to Admin | | | |

**Verdict: one view, one conditional zone.** The existing page already gates on
`isAdmin`; the redesign separates the two zones visually instead of
interleaving admin cards with user cards.

---

### `/vault` → `/vault/:safeId` → credential

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | "Find the credential and reveal it." | Path breadcrumb, credential name + `account_name` + type, and **Reveal** with its reason field | Versions, rotation schedule, metadata | Nothing role-gated — `pam:vault:*` is granted to `user` on `*` |
| **Admin** | Same, plus "is rotation healthy?" | Same, plus `next_rotation_at` / `rotation_interval_days` prominence | | Vault backup/restore lives on `/admin/vault-ops`, not here |
| **Root** | Identical to Admin | | | |

**Verdict: one view for all three roles.** This is the page where the standard
"admins see more" assumption is most wrong: the OPA bundle gives `user` the
same vault verbs as admin. Designing an admin-only vault view would
misrepresent the system.

---

### `/sessions`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | "What do I have open, and can I close it?" | Own live sessions with duration and **End session** | Ended sessions | The org-wide table; **Kill** (that's `POST /admin/actions/sessions/:id/kill`); other users' sessions |
| **Admin** | "Who is connected to what right now, and is any of it unrecorded or break-glass?" | Org-wide live table, `is_breakglass` and `recording_required` as **filters**, **Kill** with mandatory reason | Own sessions (a filter on the same table, not a separate mode); ended sessions | — |
| **Root** | Identical to Admin | | | |

**Verdict: two views sharing one table component.** The Normal User's version
is the same table minus 3 columns, minus the kill action, minus the scope
switch — driven by which endpoint answers (`/sessions/mine` vs
`/admin/sessions`). The current `SegmentedControl` for Mine/All should not
render at all for a Normal User, since they have exactly one scope.

---

### `/jit` + `/jit/requests/:id` (self-service only)

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | "Where is my request, and how long do I have?" | One lifecycle list: in-flight requests with who they wait on, active grants with countdowns | Terminal history (denied/expired/cancelled) | Approve/deny anything; other users' requests |
| **Admin / Root** | — | **Route redirects to `/admin/jit`** | | The whole page |

**Verdict: single-role page.** Already enforced by `SelfServiceOnly`. The
redesign keeps that and does not build an admin variant.

---

### `/admin/jit` — approvals

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | — | `AdminRoute` bounces them | | Everything |
| **Admin** | "What can I clear right now?" | Three-band queue: **waiting on a 2nd approval** → **new** → **break-glass WAITING**; per row, Approve/Deny inline with the four-eyes state; requests they already approved shown as blocked with the reason ("you approved this") | Grants tab, revoke, filters, history | — |
| **Root** | Same, plus "which ones can I settle outright?" | Same queue; Approve reads **"Approve (final)"**; the consequence line states the grant issues immediately | Same | — |

**Verdict: one view, root-aware labels.** All of it already exists in
`lib/fourEyes.js` (`approveButtonLabel`, `approveConsequence`,
`approveBlockedReason`) — the redesign renders it more prominently, invents
nothing.

---

### `/admin/identity` + `/admin/identity/:id`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | — | bounced | | Everything |
| **Admin** | "Find this account and fix its access." | Search + status/role facets; on detail: identity block, roles/policies with attach/detach, lifecycle actions in a risk-separated zone | Audit trail for this user, delegation status (read-only) | **Delegate admin / revoke delegation** — root-only (`MinRankToDelegateAdmin=100`); attempting it 403s |
| **Root** | Same, plus "who should hold admin?" | Same, plus **Delegate admin** enabled with scope + expiry + reason, and revoke on an active delegation | Same | Modifying an `is_protected` account — blocked for root too |

**Verdict: one view with two genuinely root-gated controls.** This is the only
page in the product where root vs admin is a real functional difference. The
current page already checks `isRoot` in five places; the redesign makes the
*reason* visible ("only root can delegate admin") instead of rendering a
disabled button with no explanation.

---

### `/admin/roles`, `/admin/policies`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | — | bounced | | Everything |
| **Admin** | "What does this role grant?" | Role list with `is_system` marked; drawer showing attached policies as readable rules | Create/edit/delete for non-system objects | Deleting system roles (`root`/`admin`/`user`) — locked, with `systemRoleLockReason()` explaining why |
| **Root** | Identical to Admin | | | Same lock — root cannot delete the root role either |

**Verdict: one view for admin and root.** No difference exists in the API.

---

### `/admin/mfa-policy`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | — | bounced | | Everything |
| **Admin** | "If I enforce this, who gets locked out?" | The **compliance preview**: accounts gated, accounts enrolled, accounts that would be locked out — before the rule editor | The rules table, per-role editing | — |
| **Root** | Identical to Admin | | | — |

**Verdict: one view.** `api/mfaPolicy.js` documents that writes used to be
root-only and are now admin-or-root; designing a root-only editor would
re-introduce drift the codebase deliberately removed.

---

### `/admin/audit` (and `/audit`)

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | "What have *I* done / what happened to my access?" | Their own events — which requires the UI to send `user_id=<me>` (see F-03) | Report generation (they hold `pam:report:Generate`) | Recordings, chain verification, other users' events |
| **Admin** | "Search the org trail and prove it hasn't been tampered with." | Facet rail + dense event stream; chain-verification state as a compliance headline | Recordings archive, report builder | — |
| **Root** | Identical to Admin | | | — |

**Verdict: two views.** Self-scoped ("My activity", reachable from Settings and
the dashboard) and org-wide (`/admin/audit`). The orphan `/audit` route
becomes the self-scoped one and gets a nav entry — fixing F-01 and F-03
together.

---

### `/admin/vault-ops`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **Normal User** | — | bounced | | Everything |
| **Admin** | "Take a backup." | Backup as the routine action | Restore, isolated, consequence-first, typed confirmation | — |
| **Root** | Identical to Admin | | | — |

**Verdict: one view.** `POST /admin/vault/restore` is `RequireAdmin`. It
*should* arguably be root-only — but that is a backend decision, listed under
Requires-backend-support, not something the UI should pretend by hiding the
button from admins who can still call the endpoint.

---

### `/settings`

| | First 5 seconds | Immediately visible | Secondary | Hidden |
|---|---|---|---|---|
| **All three roles** | "Turn on MFA / check my devices." | MFA state and enrolment; profile; theme; agent devices | Backup-code regeneration; API base info | Nothing role-gated — `/auth/me` and the MFA endpoints are identical for every role |

**Verdict: one view, no role variants.** The only role-dependent element is the
role badge on the profile block, which is data, not a variant.

---

### `/login`, `/mfa-verify`, `404`, permission-denied

Pre-auth: no persona split — the product does not know who you are yet, and
must not leak whether an identifier exists.

**Permission-denied is a missing state, not a page** (F-04). Every role can hit
it: a Normal User typing `/admin/identity`, an Admin hitting a root-only
delegation endpoint, anyone whose OPA decision denies. The design system
(Phase 4) makes it one of the four mandatory states, and it must **name the
requirement** ("This needs the root role") and **not offer Retry**.
