# Phase 1 — Audit of the current console (UI.zip)

Everything below was read out of `UI.zip`. Endpoint behaviour and response
field names were cross-checked against `backend.zip` where the two overlap;
every place they disagree is called out explicitly rather than smoothed over.

---

## 1.0 What this codebase actually is

This is **not** a naive Bootstrap dashboard, and the audit would be dishonest
if it pretended otherwise. `UI.zip` is ~31k lines of React across 24 routes
with:

- a real token layer (`index.css` + `tailwind.config.js`): `surface-*` /
  `ink-*` ramps backed by CSS custom properties, light+dark from one flip;
- a shared state wrapper (`QueryState`) that forces loading / error / empty
  branches;
- one `Button`, one `Card`, one `EmptyState`, one `DetailList`, one
  `PageHeader`, shared table primitives with real frozen-column handling
  (`tableStyles.jsx`), and `table-fixed` column widths;
- route-level code splitting, `AbortSignal` plumbed through every API call,
  React Query everywhere, a genuine four-eyes/dual-control model
  (`lib/fourEyes.js`).

So the upgrade to "enterprise-grade" is **not** a re-skin of a bad app. It is
a hierarchy, density and role-model problem in an app whose components are
mostly already good. The findings below are specific and reproducible, not
generic criticism.

---

## 1.1 Route inventory (every reachable screen)

From `src/App.jsx` and `src/pages/vault/VaultPage.jsx` (nested router).

| # | Route | Component | Guard |
|---|---|---|---|
| 1 | `/login` | `pages/auth/LoginPage` | public |
| 2 | `/mfa-verify` | `pages/auth/MfaVerifyPage` | public (needs `mfaChallenge` in store) |
| 3 | `/` | `pages/DashboardPage` | `ProtectedRoute` |
| 4 | `/resources` | `pages/resources/ResourcesPage` | `ProtectedRoute` |
| 5 | `/resources/:id` | `pages/resources/ResourceDetailPage` | `ProtectedRoute` |
| 6 | `/vault` | `pages/vault/SafesListPage` (index of nested router) | `ProtectedRoute` |
| 7 | `/vault/:safeId` | `pages/vault/SafeDetailPage` | `ProtectedRoute` |
| 8 | `/vault/:safeId/credentials/:credentialId` | `pages/vault/CredentialDetailPage` | `ProtectedRoute` |
| 9 | `/sessions` | `pages/sessions/SessionsPage` | `ProtectedRoute` |
| 10 | `/jit` | `pages/jit/JitPage` | `ProtectedRoute` + `SelfServiceOnly` (admins redirected to `/admin/jit`) |
| 11 | `/jit/requests/:id` | `pages/jit/JitRequestDetailPage` | same |
| 12 | `/audit` | `pages/audit/AuditPage` | `ProtectedRoute` — **orphan, see F-01** |
| 13 | `/settings` | `pages/SettingsPage` | `ProtectedRoute` |
| 14 | `/admin` | → redirect `/admin/identity` | `AdminRoute` |
| 15 | `/admin/identity` | `pages/admin/IdentityListPage` | `AdminRoute` |
| 16 | `/admin/identity/:id` | `pages/admin/IdentityDetailPage` | `AdminRoute` |
| 17 | `/admin/roles` | `pages/admin/RolesPage` | `AdminRoute` |
| 18 | `/admin/mfa-policy` | `pages/admin/MfaPolicyPage` | `AdminRoute` |
| 19 | `/admin/policies` | `pages/admin/PoliciesPage` | `AdminRoute` |
| 20 | `/admin/jit` | `pages/admin/AdminJitPage` | `AdminRoute` |
| 21 | `/admin/audit` | `pages/admin/AdminAuditPage` | `AdminRoute` |
| 22 | `/admin/vault-ops` | `pages/admin/AdminVaultOpsPage` | `AdminRoute` |
| 23 | `*` | `pages/NotFoundPage` | `ProtectedRoute` |
| — | *(none)* | `pages/admin/AdminOverviewPage` | **dead file, see F-02** |

### Sub-screens that are screens in everything but the URL

These carry their own data fetches, their own empty/error states and their own
toolbars. They are pages wearing a modal/tab costume and are treated as pages
for the rest of this exercise.

| Sub-screen | Host | Type |
|---|---|---|
| MFA enrolment (QR → verify → backup codes) | `SettingsPage` tab, `MfaEnforcementGate` | 3-step wizard, 614 LOC |
| Session recording player | `AdminAuditPage` tab | full-screen viewer, 1265 LOC |
| Compliance report builder | `AuditPage`, `AdminAuditPage` | modal-as-page, 170 LOC |
| Audit event drawer | `AuditPage`, `AdminAuditPage`, `IdentityDetailPage` | right drawer |
| JIT request drawer | `AdminJitPage` | right drawer (own `useQuery`) |
| Resource drawer | `ResourcesPage` | right drawer |
| Role / policy drawers | `RolesPage`, `PoliciesPage` | right drawer with attach/detach mutations |
| Delegate-admin modal | `IdentityDetailPage` | root-only write |
| Pair-agent panel | `ResourceDetailPage`, `SettingsPage` | live pairing code + countdown |
| Backup / restore panel | `AdminVaultOpsPage` | the entire page's content |
| Reveal-credential modal | `CredentialDetailPage`, `SafeDetailPage` | reason-gated secret reveal |
| Create modals ×8 | user, role, policy, resource, safe, folder, credential, JIT request | forms, 238–528 LOC each |

`AdminVaultOpsPage.jsx` is **8 lines**: a `PageHeader` plus
`<BackupRestorePanel />`. The page is the panel.

---

## 1.2 The real backend surface

`src/api/*.js` is *almost* the complete client surface: **86** endpoint+verb
pairs across 12 modules, plus **2** called directly from a component.

> **Correction (made during the pass-2 re-crawl).** This section originally
> claimed no component calls the HTTP client directly. That is wrong.
> `components/audit/SessionRecordingViewer.jsx` imports
> `* as httpModule from '../../lib/http'` and calls it at lines 110, 128 and
> 138 — `GET /pam/admin/recordings/:id/cast` and
> `GET /pam/admin/recordings/:id/commands`. The original grep looked for
> `fetch(` and `axios`, neither of which that file uses. Both endpoints are
> absent from the supplied `backend.zip` route table, same skew caveat as the
> other six. Total is still 88; the sentence under it was not.

### Client modules → endpoints

| Module | Endpoints |
|---|---|
| `auth.js` | `POST /api/v1/auth/login`, `POST /auth/mfa/verify`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/mfa/setup/initiate`, `POST /auth/mfa/setup/verify`, `POST /auth/mfa/backup-codes/regenerate` ⚠ |
| `resources.js` | `GET /pam/resources/groups`, `GET /pam/resources`, `GET /pam/resources/:id`, `GET /pam/resources/:id/connect-info`, `POST /pam/resources/:id/sessions` |
| `adminResources.js` | `POST /pam/admin/resources`, `DELETE /pam/admin/resources/:id`, `POST /pam/admin/resources/:id/credential`, `POST /pam/admin/resources/:id/rotate` |
| `sessions.js` | `GET /pam/sessions/mine`, `POST /pam/sessions/:id/end` |
| `jit.js` | `POST /pam/jit/requests`, `POST /pam/jit/breakglass`, `GET /pam/jit/requests`, `GET /pam/jit/requests/:id`, `POST /pam/jit/requests/:id/cancel`, `GET /pam/jit/grants` |
| `vault.js` | `GET /pam/credential-types`, `GET /pam/safes`, `POST /pam/safes`, `GET /pam/safes/:id`, `GET /pam/safes/:id/folders`, `POST /pam/safes/:id/folders`, `GET /pam/safes/:id/credentials`, `POST /pam/safes/:id/credentials`, `GET /pam/credentials/:id`, `POST /pam/credentials/:id/reveal`, `POST /pam/credentials/:id/versions`, `POST /pam/credentials/:id/password-change`, `POST /pam/credentials/:id/rotate` |
| `audit.js` | `GET /pam/audit`, `GET /pam/audit/request/:id`, `GET /pam/audit/user/:id`, `GET /pam/audit/resource/*`, `POST /pam/audit/report` (blob) |
| *(no module — direct `http` calls from `SessionRecordingViewer.jsx`)* ⚠ | `GET /pam/admin/recordings/:id/cast`, `GET /pam/admin/recordings/:id/commands` |
| `admin.js` | `GET /pam/admin/jit-requests`, `GET /pam/admin/jit-requests/:id`, `GET /pam/admin/grants`, `GET /pam/admin/sessions`, `GET /pam/admin/recordings`, `GET /pam/admin/audit`, `GET /pam/admin/audit/verify`, `GET /pam/admin/breakglass`, `GET /pam/admin/breakglass/:id/report`, `GET /pam/admin/stats`, `POST /pam/admin/actions/jit-requests/:id/approve`, `.../deny`, `POST /pam/admin/actions/grants/:id/revoke`, `POST /pam/admin/actions/sessions/:id/kill` |
| `identity.js` | `GET/POST /pam/admin/identity/users`, `GET/PATCH/DELETE /…/users/:id`, `POST /…/:id/status`, `POST /…/:id/reset-password`, `POST/DELETE /…/:id/roles[/:role_name]`, `POST/DELETE /…/:id/policies[/:policy_id]`, `POST/DELETE /…/:id/delegate-admin`, `GET /…/:id/delegation`, `POST /…/:id/reset-mfa` ⚠ |
| `rbac.js` | full CRUD on `/pam/admin/rbac/roles` and `/pam/admin/rbac/policies`, plus `POST/DELETE /roles/:id/policies[/:policy_id]` |
| `mfaPolicy.js` ⚠ | `GET /pam/admin/mfa-policy`, `GET /…/compliance`, `PUT /…/rules/:roleName`, `DELETE /…/rules/:roleName` |
| `agent.js` | `POST /pam/agent/pair/init`, `GET /pam/agent/devices`, `DELETE /pam/agent/devices/:id`, `POST /pam/resources/:id/launch` |
| `adminVault.js` | `POST /pam/admin/vault/backup`, `POST /pam/admin/vault/restore` |

⚠ **Version skew — read before treating anything as "missing".**
Eight endpoints the frontend calls do **not** exist in the supplied
`backend.zip` route table (`cmd/pam-api/main.go`) — the two recording
sub-routes above, plus:
`POST /auth/mfa/backup-codes/regenerate`,
`POST /pam/admin/identity/users/:id/reset-mfa`, and all four
`/pam/admin/mfa-policy*` routes. `src/api/mfaPolicy.js` cites
`internal/api/handlers/mfa_policy_handler.go`, which is not in the zip.
**Conclusion: `backend.zip` is an older snapshot than the API the UI is
written against — not proof these endpoints are fabricated.** Everything the
mockups use is drawn from the UI's own client layer, and the six above are
listed per-page as *verify-before-build*.

### Response shapes that constrain design

Field names below are from `backend/internal/models/*.go` — these are the real
JSON keys, and the mockup fixtures use exactly these.

- **`GET /admin/stats`** → `{ pending_approvals, active_sessions, active_grants, active_breakglass_grants, active_resources, generated_at }`.
  **Point-in-time counts only. No history, no previous period, no series.**
  This single fact forbids every trend arrow, delta chip and sparkline on
  every metric in the product. (`DashboardPage` also reads
  `awaiting_first_approval` / `awaiting_second_approval` behind a null guard —
  not in `backend.zip`'s handler; same skew caveat.)
- **`JITRequest`** → `id, request_type, requester_user_id, requester_username, resource_id, resource_name, resource_type, action, duration_minutes, reason, ticket_ref, status, source_ip, authz_decision_id, requested_at, request_expires_at, available_at, decided_at, approver_user_id, approver_username, decision_reason, grant_id`.
- **`AccessGrant`** → `id, request_id, user_id, username, resource_id, resource_name, action, is_breakglass, recording_required, status, granted_at, expires_at, revoked_at, revoked_by, revoke_reason, sessions_killed, iam_policy_id, iam_sync_status, iam_sync_error`.
- **`ConnectionSession`** → `id, user_id, username, resource_id, resource_name, resource_type, protocol, source_ip, status, started_at, ended_at, duration_seconds, grant_id, jit_request_id, is_breakglass, recording_required, recording_id, kill_reason, killed_by, authz_decision_id, authz_allowed`.
- **`AuditLog`** → `sequence_number, id, org_id, user_id, username, email, service_name, actor_type, category, action, outcome, severity, resource, resource_type, resource_id, resource_name, details, justification, source_ip, user_agent, request_id, session_id, grant_id, authz_decision_id, prev_hash, entry_hash, hash_version, occurred_at`.
- **`PAMResource`** → `id, name, description, resource_type, host, port, database_name, connect_mode, console_url, extra_config, vault_entry_id, requires_jit, always_record, is_active, created_by, created_at`.
- **`Credential`** → `id, safe_id, folder_id, resource_id, name, account_name, credential_type, is_breakglass, breakglass_note, status, version, last_rotated_at, next_rotation_at, rotation_interval_days, created_by, updated_by`.
- **`SessionRecording`** → `id, session_id, grant_id, user_id, username, resource_id, resource_name, is_breakglass, format, storage_bucket, storage_key, size_bytes, sha256, status, started_at, ended_at, duration_seconds`.
- **`User`** → `user_id, username, email, full_name, status, mfa_enabled, failed_login_attempts, locked_until, last_login_at, last_login_ip, account_id, is_protected, created_by, created_at`.
- **Resource types in use** (`config/constants.js`): `postgresql, mongodb, redis, clickhouse, minio, qdrant, metabase, langfuse, web, oracle`. Not AWS/GCP — this is a data-platform estate. Mockup fixtures use these.

---

## 1.3 The Phase 1 table

| Page | Purpose | Current pattern | Core problem | APIs/endpoints used |
|---|---|---|---|---|
| **`/` Dashboard (admin branch)** | Org posture + what's waiting on you | `Masthead` (greeting + **5-cell KPI strip**) → "Needs your attention" (2 cards) → Activity (area + donut + bar list) → Administration shortcuts. **10 `<Card>` surfaces plus a 5-cell strip in one file.** | Five equal-weight numbers, none dominant. Only *one* of the five (`pending_approvals`) is actionable; break-glass is the alarm; the other three are inventory. Greeting ("Good to see you, root") occupies the position of highest visual authority on a security console. Charts are computed client-side from an audit sample the user picks the size of — an implementation detail promoted to a control. | `GET /admin/stats`, `GET /admin/jit-requests` (×2: `PENDING`, `PARTIALLY_APPROVED`), `GET /admin/audit` (paged sample), `POST /admin/actions/jit-requests/:id/approve`, `.../deny` |
| **`/` Dashboard (user branch)** | Your grants, requests, sessions, activity | `Masthead` (4-cell KPI strip) → attention cards → activity charts | Same equal-weight problem. **Worse: "your activity" is not yours.** `fetchSelfAuditSample` calls `GET /pam/audit` with only `limit`/`offset` — no `user_id` — and the backend handler does not scope by caller either (F-03). | `GET /jit/grants`, `GET /jit/requests` (×2), `GET /sessions/mine`, `GET /pam/audit` |
| **`/resources`** | Browse the connectable estate | `PageHeader` → toolbar → **grid of `ResourceCard`s** or a table, toggled by `SegmentedControl`; grouped by `listResourceGroups` | Card-per-resource is a card-per-row list: the data (name, type, host:port, JIT flag, record flag, credential state) is tabular and comparative. Cards force 3-per-row, so 30 resources become 10 rows of scrolling instead of 30 scannable lines. | `GET /pam/resources/groups` |
| **`/resources/:id`** | Inspect + connect + (admin) manage a resource | `PageHeader` → `TabBar` (Overview / Policies / Sessions / Audit) → cards. `ResourceDetailTabs.jsx` alone renders **6 `<Card>`s** across its four tabs, on top of the page's own 2 | Every key/value pair is boxed. Four tabs where two of them (Policies, Audit) are read-only cross-references. The connect action — the reason the page exists — is a card among cards, not the page's primary. | `GET /pam/resources/:id`, `GET /…/connect-info`, `POST /…/sessions`, `POST /…/launch`, `DELETE /admin/resources/:id`, `POST /admin/resources/:id/credential`, `POST /…/rotate`, `GET /audit/resource/*` |
| **`/vault` Safes list** | Pick a safe | `PageHeader` → toolbar → card grid **or** table (`SegmentedControl`) | Same card-per-row problem. A safe has 4 attributes (`name, description, retention_days, is_default`) — a card is 5× the height of the line it needs. | `GET /pam/safes` |
| **`/vault/safes/:id`** | Browse folders + credentials in a safe | `PageHeader` → 5 cards, one table, folder list, pagination | Folders and credentials are two flat lists side by side rather than one navigable tree/path — `Folder.path` (`/prod-databases/mysql`) is returned and unused. | `GET /pam/safes/:id`, `GET /…/folders`, `GET /…/credentials` |
| **`/vault/credentials/:id`** | Reveal / rotate / version a secret | `PageHeader` → 4 stacked `<Card>`s, each a bordered box around 2–4 rows | The one dangerous, audited action on the page (reveal, reason-gated) has no more visual weight than the metadata block above it. Rotation state (`next_rotation_at`, `rotation_interval_days`, `version`) is returned and under-used. | `GET /pam/credentials/:id`, `POST /…/reveal`, `POST /…/versions`, `POST /…/password-change`, `POST /…/rotate` |
| **`/sessions`** | Watch and terminate live sessions | `KpiStrip` → `SegmentedControl` (Mine / All) → toolbar → table with frozen first column, bulk bar, drawer | The strongest page in the app structurally. Problems: it opens with a KPI strip on a page whose entire value is the live table; "Mine vs All" is a segmented control rather than a consequence of role; recording state (`recording_required`, `recording_id`) is a column, not a filter. | `GET /pam/sessions/mine`, `POST /pam/sessions/:id/end`, `GET /admin/sessions`, `POST /admin/actions/sessions/:id/kill` |
| **`/jit` (self-service)** | Raise a request, watch your grants | `PageHeader` → "Active access" rail → two paginated tables (requests, grants) → create modal | Two tables of the same lifecycle presented as unrelated objects. A request that became a grant is one thing at two stages; the page splits it and makes the user correlate by resource name. | `GET /jit/requests`, `GET /jit/grants`, `POST /jit/requests/:id/cancel`, `POST /jit/requests`, `POST /jit/breakglass` |
| **`/jit/requests/:id`** | Track one request | `PageHeader` → 3 `<Card>`s + `ApprovalProgress`, 676 LOC | The approval trail — the only thing that changes — is one card among nine. Status, countdown and next step should be the page, not a row in it. | `GET /jit/requests/:id`, `GET /jit/grants`, `POST /jit/requests/:id/cancel` |
| **`/audit` (self)** | Search the audit trail | `PageHeader` → `KpiStrip` (3) → `AuditFilterBar` → `AuditTable` → drawer + report builder | **Orphan route** (F-01) — reachable by URL only; not in `CONSOLE_NAV` (commented out). And its results are not self-scoped (F-03). | `GET /pam/audit`, `POST /pam/audit/report`, `GET /admin/audit/verify` (admin only) |
| **`/settings`** | Profile, MFA, theme, agent devices | `PageHeader` → `TabBar` → **9 `<Card>`s** (plus 5 more inside `MfaEnrollment`) | A settings page built as a card gallery. Rows of `label / control` in bordered boxes; no grouped form rhythm. | `GET /auth/me`, MFA setup ×2, `POST /auth/mfa/backup-codes/regenerate` ⚠, `GET/DELETE /agent/devices`, `POST /agent/pair/init` |
| **`/admin/identity`** | Find and triage accounts | `PageHeader` → toolbar (search, facets, export) → table (frozen name col) → bulk bar → pagination | Good bones. `BulkActionBar` exists and is rendered, but **there is no bulk endpoint** — every "bulk" action is an N-request loop, and the UI must not imply atomicity. Role hydration fires a second query per page because the list payload omits roles (`lib/roles.js` documents the drift). | `GET /admin/identity/users`, `GET /…/users/:id` (role hydration), `GET /admin/rbac/roles` |
| **`/admin/identity/:id`** | Everything about one account | `PageHeader` → `TabBar` → **10 `<Card>`s**, 7 `ConfirmDialog`s, 1516 LOC | The most consequential screen in the product (reset password, reset MFA, delegate admin, delete) rendered as a flat card wall. Destructive and routine actions share one visual weight class. | `GET /…/users/:id`, `PATCH`, `DELETE`, `POST /…/status`, `/reset-password`, `/reset-mfa` ⚠, `POST/DELETE /…/roles`, `/policies`, `POST/DELETE /…/delegate-admin`, `GET /…/delegation`, `GET /audit/user/:id`, `GET /rbac/roles`, `GET /rbac/policies` |
| **`/admin/roles`** | Define roles, attach policies | `PageHeader` → toolbar → table → drawer (attach/detach) → create modal + confirm | Fine. Weakness: a role's blast radius (how many users hold it) is never shown — and cannot be, from `GET /rbac/roles`. See "Requires backend support". | `GET/POST/PATCH/DELETE /admin/rbac/roles`, `GET /roles/:id`, `POST/DELETE /roles/:id/policies`, `GET /rbac/policies` |
| **`/admin/policies`** | Define allow/deny policies | Same shape as Roles | `Policy.actions` / `Policy.resources` are string arrays rendered as badge soup; a policy is a rule and reads better as a rule. | `GET/POST/PATCH/DELETE /admin/rbac/policies` |
| **`/admin/mfa-policy`** | Role-gated MFA enforcement | `PageHeader` → 4-col grid → table of rules → modal | The compliance view (`GET /…/compliance`: who would be locked out if you enforced now) is the page's real payload and is buried under the rule editor. | `GET /admin/mfa-policy`, `GET /…/compliance`, `PUT/DELETE /…/rules/:role` ⚠, `GET /rbac/roles` |
| **`/admin/jit`** | Approve/deny requests, revoke grants | `PageHeader` → `TabBar` (Requests / Grants) → segmented filters → table → drawer with `ApprovalTrail` → confirms. 1187 LOC | The approval queue is the highest-value screen in a PAM console and it opens as a generic filtered table. Four-eyes state (`PARTIALLY_APPROVED` = waiting on *one specific different person*) is a badge, not the organising principle. | `GET /admin/jit-requests`, `GET /admin/jit-requests/:id`, `GET /admin/grants`, `GET /admin/stats`, `POST /actions/…/approve`, `/deny`, `POST /actions/grants/:id/revoke` |
| **`/admin/audit`** | Org audit, recordings, chain verify, reports | `PageHeader` → `TabBar` (Events / Recordings) → `KpiStrip` ×3 → filter bar → table → drawer → recording viewer → report builder | Four unrelated jobs on one route. Chain verification (`GET /admin/audit/verify` — tamper evidence, the compliance headline) is a button inside a tab. | `GET /admin/audit`, `GET /admin/recordings`, `GET /admin/audit/verify`, `POST /pam/audit/report` |
| **`/admin/vault-ops`** | Backup / restore the vault | `PageHeader` + `BackupRestorePanel` (2 cards, 3 confirms) | An 8-line page. Restore is the most destructive action in the product and sits in a card with the same weight as backup. No backup history — `POST /vault/backup` returns a key and nothing lists them. | `POST /admin/vault/backup`, `POST /admin/vault/restore` |
| **`/login`** | Authenticate | Split hero (marketing gradient left, form right), 355 LOC | Two different visual languages in one product: the auth screens use `slate-*`/`white` literals and a marketing hero; the console uses the `surface`/`ink` token system. | `POST /auth/login` |
| **`/mfa-verify`** | TOTP / backup code | Same split hero, `OtpInput`, 559 LOC | Same. Also: no way back to `/login` other than browser Back. | `POST /auth/mfa/verify` |
| **`*` Not found** | 404 | Centred glyph + link | Fine. Does not distinguish "no such page" from "not allowed" (F-04). | — |

---

## 1.4 Generic / low-effort patterns, with evidence

Each of these is a file:line-level fact, not an impression.

**F-01 — Orphan route.** `config/nav.js:29` has
`// { to: '/audit', label: 'Audit', icon: ScrollText },` commented out.
`/audit` still routes (`App.jsx`). The page is live and unreachable from the UI.

**F-02 — Dead page.** `pages/admin/AdminOverviewPage.jsx` (462 LOC, 9 cards,
4 `KpiStrip`s) is not imported by any route. `App.jsx` documents its removal in
a comment but the file shipped.

**F-03 — "Your activity" is org-wide.** `DashboardPage.jsx:183`
`fetchSelfAuditSample` → `searchAudit({ limit, offset })`, no `user_id`.
Backend `AuditHandler.Search` reads filters from query params only and never
scopes to the caller. The seeded `user` role's OPA policy
(`opa/policies/default_bundle.json`, `standard-user-access`) grants
`pam:audit:Read` on `"*"`. Net effect: a Normal User's dashboard "your
activity" panel, and `/audit` if they find the URL, render **other people's
audit events**. This is a labelling bug and a data-exposure question, and it
determines what the Normal User dashboard is allowed to show.

**F-04 — No permission-denied state anywhere.**
`AdminRoute.jsx` → `<Navigate to="/" replace />` (silent bounce, no
explanation). `QueryState.jsx` renders every failure, including 403, as
"Couldn't load this data" with a **Retry** button — retrying a 403 forever.
`lib/apiError.js` is the only place a 403 could be distinguished and isn't.

**F-05 — Two competing metric instruments, both claiming to be the one.**
`KpiStrip.jsx` header comment: *"the console's one metric instrument."*
`StatCard.jsx` header comment: *"Not a 'stat card': a drawn instrument
plate."* Both are exported; `StatCard` carries an accent rail, a `tex-grid`
texture, an icon chip with tinted ring, and a hover lift. This is system
drift.

**F-06 — Decoration standing in for hierarchy.** `index.css` ships
`.tex-grid` (28px modular grid), `.tex-hatch` (45° hatch), `.edge-lit` /
`.edge-lit-raised` (inset white highlight on every `Card`), `.dot-live` ping.
`Card` and `StatCard` both apply `hover:-translate-y-0.5`. Enterprise-grade
reads as *restraint*: Linear, Stripe and Vercel get depth from spacing and
type, not from a texture behind a number and a card that lifts when you point
at it.

**F-07 — Boxed everything.** `<Card>` render sites per file: Dashboard 10,
IdentityDetail 10, Settings 9 (+5 inside `MfaEnrollment`), ResourceDetailTabs 6
(+2 on its host page), MfaEnrollment 5, AdminJit 5, ResourceAccess 4,
CredentialDetail 4, ResourcesPage 4, AdminAudit 4, SafeDetail 3,
JitRequestDetail 3, MfaPolicy 3. `Card` = 1px border + `--shadow-card` + inset highlight +
12px radius. `Toolbar` is *also* a bordered, shadowed box. `KpiStrip` is *also*
a bordered box. A detail page is therefore ~20 nested boxes deep in places.

**F-08 — KPI strip as the default page opener.** Five surfaces open with one:
Dashboard (5 cells), AdminOverview (dead), `AdminAuditPage:93`,
`AuditPage:133`, `SessionsPage:367`. On Sessions and Audit the strip pushes the actual
instrument — the live table — below the fold.

**F-09 — Density achieved by shrinking the root.** `index.css` sets
`html { font-size: 14.5px }`, stepping to 15.25px ≥1800px and 16.25px ≥2400px.
It works, and the reasoning in the comment is sound, but it means Tailwind's
4px spacing unit is really 3.625px, and it silently changes at two breakpoints
— so there is **no fixed pixel grid** in the product. Type sizes are also
authored as arbitrary values in several places (`text-[0.9375rem]`,
`text-[1.35rem]`, `text-[1.75rem]`, `text-[2rem]`, `text-[2.75rem]`,
`text-[1.625rem]`, `text-[2.5rem]`) — that is a scale of ~11 sizes, not 6.

**F-10 — Commented-out product decisions left in the source.** The denied-
actors panel (`DashboardPage`), the status badge in the approval queue row,
the `scopeNote`, the Admin Center section action, the `/audit` nav entry, the
chain-verify import. Each is a decision half-made and shipped.

**F-11 — Two visual languages.** `LoginPage` / `MfaVerifyPage` use
`slate-900`, `white`, `text-[4.25rem]` marketing type and a gradient hero.
Every console page uses `surface-*` / `ink-*`. A user's first two screens do
not look like the product.

**F-12 — Bulk UI without bulk endpoints.** `BulkActionBar` renders on
`IdentityListPage` and `SessionsPage`. No bulk endpoint exists in either the
UI's client layer or the backend route table. Any "bulk" action is N sequential
requests with N failure modes — the UI must say so, or not offer it.

**F-13 — Icons as decoration.** `CardTitle` takes an `icon` prop and nearly
every card passes one; `KpiCell` and `StatCard` take one; `EmptyState` takes
one. An icon next to the words "Approval queue" adds nothing — icons should
mark *type* (resource kind, credential kind, outcome) or *action*, and
`ResourceTypeIcon` does exactly that and is the right pattern.

**F-14 — Primary/secondary not enforced.** `Button` has 6 variants, but
`variant="secondary"` (the default) carries `shadow-card` — so the *default*
button is a raised object. Pages routinely render 3–5 same-weight controls in
a header row (`AdminAuditPage`, `SessionsPage`, `ResourcesPage`).

---

## 1.5 What is already good and must survive the redesign

Called out so the redesign doesn't regress it:

- `tableStyles.jsx` — frozen-column background handling and `table-fixed`
  column widths (`COL`) are correct and hard-won. Keep verbatim.
- `QueryState` — the loading/error/empty contract. Extend with a
  permission-denied branch; don't replace.
- `lib/fourEyes.js` — the dual-control rules, and the principle that the
  client never decides quorum. This is the domain model; the redesign renders
  it better, changes nothing about it.
- `lib/roles.js` — absorbs a real payload inconsistency in one place.
- Route-level code splitting and `AbortSignal` on every query.
- `KpiStrip`'s own comment: *"a security console must never draw a number the
  backend didn't return."* That rule governs Phase 5.
