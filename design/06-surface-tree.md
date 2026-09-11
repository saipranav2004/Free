# Step 1 — The full surface tree, and every gap in pass 1

Pass 1 redesigned **24 routes**. The codebase contains **68 distinct
surfaces**. That gap is the finding.

Everything below was re-crawled from `UI.zip`, component by component, not
inferred from the route table.

---

## 0. Two corrections to the Phase 1 audit

Found while re-crawling. Both were wrong in the first pass and are corrected
in `01-audit.md`.

**C-01 — "no component calls the HTTP client directly" was false.**
`components/audit/SessionRecordingViewer.jsx` imports
`* as httpModule from '../../lib/http'` and makes **three** direct calls
(lines 110, 128, 138). The original grep looked for `fetch(` and `axios`,
which that file uses neither of. The API layer is *nearly* the whole client
surface — not all of it.

**C-02 — two endpoints were missing from the inventory.**
`GET /api/v1/pam/admin/recordings/:id/cast` (asciicast v2 transcript) and
`GET /api/v1/pam/admin/recordings/:id/commands` (keystroke/command log),
both called only from that viewer. Neither is in the supplied `backend.zip`
route table — same version-skew caveat as the other six.

Corrected count: **86 endpoint+verb pairs in `src/api/` + 2 called directly
from a component = 88.** The total was right; the sentence under it was not.

---

## 1. The surface tree

Legend — **✅ mocked in pass 1** · **⬜ gap** · *(new)* = added in this pass.

```
APP SHELL
├── ✅ Sidebar (expanded / icon rail / mobile drawer)
├── ⬜ Top bar
│   ├── ⬜ Breadcrumb                          TopNavbar.jsx
│   ├── ⬜ Global search (⌘K)                  GlobalSearch.jsx — resources + safes + accounts
│   ├── ⬜ Quick-jump palette                  QuickJump.jsx — navigation targets only
│   ├── ⬜ Notifications menu                  NotificationsMenu.jsx — 4 queries, admin/self variants
│   ├── ⬜ Theme toggle (segmented)            ThemeToggle.jsx
│   └── ⬜ User menu                           UserMenu.jsx — avatar, MFA posture, Settings, Sign out
├── ⬜ MFA enforcement gate (full-screen block) MfaEnforcementGate.jsx
├── ⬜ Error boundary fallback                 ErrorBoundary.jsx
├── ⬜ Session-expired toast + redirect        App.jsx SessionExpiredBridge
└── ⬜ Toast system (141 call sites: 70 error / 66 success / 5 info / 2 warning)

/ DASHBOARD                                     ✅
├── ✅ Admin branch · ✅ User branch
├── ⬜ Approve confirm dialog                  reason optional
├── ⬜ Deny confirm dialog                     reason REQUIRED, destructive
└── ✅ All-clear / empty state

/resources                                      ✅
├── ⬜ Resource preview drawer                 ResourceDrawer.jsx
├── ⬜ Create resource wizard (3 steps + review) CreateResourceModal.jsx — 532 LOC
│   ├── ⬜ Step 1 Identity     name·resource_type·description
│   ├── ⬜ Step 2 Connection   host·port·database_name·connect_mode·console_url·extra_config
│   ├── ⬜ Step 3 Governance   requires_jit·always_record
│   ├── ⬜ Step 4 Review
│   └── ⬜ Per-step inline validation (blocks advance)
└── /resources/:id                              ✅
    ├── ⬜ Connect panel                       ConnectPanel.jsx — web terminal / desktop agent / console URL
    ├── ⬜ Pair-agent panel                    PairAgentPanel.jsx — live code + countdown
    ├── ⬜ Store / rotate credential form      inline, ResourceDetailPage
    ├── ⬜ Delete resource confirm             destructive
    └── ✅ Tabs → now sections

/vault                                          ✅
├── ⬜ Create safe modal                       name·description·retention_days
└── /vault/:safeId                              ✅
    ├── ⬜ Create folder modal                 name·parent_folder_id (+ live path preview)
    ├── ⬜ Create credential modal             name·account_name·credential_type·secret_plaintext·
    │                                          description·folder_id·rotation_interval_days
    ├── ⬜ Reveal credential modal             reason → plaintext + expiry countdown + copy
    └── /vault/:safeId/credentials/:id          ✅
        ├── ⬜ Reveal modal (same)
        ├── ⬜ New version form                secret_plaintext·reason
        ├── ⬜ Password-change form            secret_plaintext (pushes to target)
        └── ⬜ Request rotation confirm

/sessions                                       ✅
├── ✅ Session drawer
├── ⬜ End own session confirm
├── ⬜ Kill session confirm                    reason REQUIRED, destructive
└── ⬜ Bulk kill — per-item progress + partial-failure result

/jit                                            ✅
├── ⬜ Create JIT request modal                resource_id·duration_minutes·reason·action·ticket_ref
├── ⬜ Break-glass request modal               same fields, cooling-off warning, shorter max duration
├── ⬜ Withdraw request confirm
└── /jit/requests/:id                           ✅
    └── ⬜ Withdraw confirm

/activity                                       ✅
├── ✅ Event drawer
└── ⬜ Report builder                          from·to·format (csv/xlsx/pdf), MFA-gated

/settings                                       ✅
├── ⬜ MFA enrolment wizard                    idle → QR + verify → backup codes
├── ⬜ Regenerate backup codes confirm         invalidates the old set
├── ⬜ Pair-agent panel
└── ⬜ Revoke device confirm

/admin/jit                                      ✅
├── ✅ Request drawer + approval trail
├── ⬜ Approve confirm                         root vs 2-of-2 consequence copy
├── ⬜ Deny confirm                            reason REQUIRED
└── ⬜ Revoke grant confirm                    reason REQUIRED, states sessions_killed

/admin/identity                                 ✅
├── ⬜ Create user modal                       full_name·username·email·password·role
│   └── ⬜ Password strength meter + generator
└── /admin/identity/:id                         ✅
    ├── ⬜ Edit profile inline form            full_name·email
    ├── ⬜ Assign role picker
    ├── ⬜ Attach policy picker
    ├── ⬜ Delegate-admin modal (root only)    reason·expires_at·scope_resource_ids·replace_admin
    ├── ⬜ Revoke delegation confirm
    ├── ⬜ Set status confirm                  suspend / reinstate / unlock
    ├── ⬜ Reset password form                 new_password + strength + generator
    ├── ⬜ Reset MFA confirm
    └── ⬜ Delete user confirm                 typed, irreversible

/admin/roles                                    ✅
├── ✅ Role drawer
├── ⬜ Create role modal                       name·description (+ starter policies)
├── ⬜ Attach / detach policy                  inside drawer
└── ⬜ Delete role confirm

/admin/policies                                 ✅
├── ⬜ Create policy modal                     name·description·effect·actions[]·resources[]
└── ⬜ Delete policy confirm

/admin/mfa-policy                               ✅
├── ⬜ Rule editor modal                       role_name·mode·grace_period_days
└── ⬜ Delete rule confirm

/admin/audit                                    ✅
├── ✅ Event drawer
├── ⬜ Session recording player                SessionRecordingViewer.jsx — 1265 LOC
│   ├── ⬜ Dual pane: replay + searchable command log, one shared timeline
│   ├── ⬜ Transport: play/pause/restart/seek/speed
│   ├── ⬜ Download .cast
│   └── ⬜ Fullscreen
└── ⬜ Report builder

/admin/compliance                               ✅ (new route in pass 1)
├── ⬜ Report builder modal
├── ⬜ Re-verify chain — running / result
└── ⬜ Break-glass register + per-grant report

/admin/vault-ops                                ✅
├── ⬜ Backup result (object key + copy)
└── ⬜ Restore confirm                         typed, most destructive action in the product

TABLE CHROME — exists in TableControls.jsx, used by 6 pages, DROPPED in pass 1
├── ⬜ SortHeader          sortable columns
├── ⬜ ColumnChooser       show/hide columns
├── ⬜ ExportMenu          CSV / JSON
├── ⬜ SavedViewsMenu      save / apply / remove a filter set
├── ⬜ RefreshControl      manual refresh + auto-refresh toggle + "updated at"
├── ⬜ ActiveFilters       chips with clear-all
└── ⬜ Pagination          page size + range
```

---

## 2. Every gap, by name

**44 surfaces.** Grouped by why they were missed.

### A. Modals that exist in code and were never mocked (11)

| # | Component | Route | Why it matters |
|---|---|---|---|
| 1 | `CreateUserModal` | `/admin/identity` | The single most-used create form in the product |
| 2 | `CreateRoleModal` | `/admin/roles` | |
| 3 | `CreatePolicyModal` | `/admin/policies` | `actions[]`/`resources[]` builder |
| 4 | `DelegateAdminModal` | `/admin/identity/:id` | The one root-only write |
| 5 | `CreateResourceModal` | `/resources` | 3-step wizard + review, 532 LOC |
| 6 | `CreateSafeModal` | `/vault` | |
| 7 | `CreateFolderModal` | `/vault/:safeId` | |
| 8 | `CreateCredentialModal` | `/vault/:safeId` | Handles the plaintext secret |
| 9 | `CreateJitRequestModal` | `/jit` | Two variants: standard and break-glass |
| 10 | `RevealCredentialModal` | vault ×2 | The most sensitive action in the product |
| 11 | `MfaEnrollment` | `/settings`, gate | 3-step wizard, 614 LOC |

### B. Confirmation dialogs (19 render sites, 13 distinct) — none mocked

Approve JIT · Deny JIT · Revoke grant · End own session · Kill session ·
Withdraw own request · Delete policy · Delete role · Delete resource ·
Set user status · Revoke delegated admin · Reset MFA · Delete user ·
Restore vault.

Four of them require a typed reason (`requireReason`) and are written to the
audit log; the first pass showed none of that.

### C. Drawers / side panels (2 of 6 missed)

`ResourceDrawer` (list preview) · the policy drawer — pass 1 replaced it with
an inline list, which is a defensible change but was never stated as one.

### D. Menus and popovers (7) — none mocked

`GlobalSearch` · `QuickJump` · `NotificationsMenu` · `UserMenu` ·
`ExportMenu` · `ColumnChooser` · `SavedViewsMenu`.

### E. Embedded panels (5) — none mocked

`ConnectPanel` · `PairAgentPanel` · `ReportBuilder` ·
**`SessionRecordingViewer`** · store/rotate-credential inline form.

The recording player is the largest single component in the codebase (1265
LOC) and already has a considered design — a dual pane with a shared
timeline, citing CyberArk PVWA, BeyondTrust, Datadog Session Replay and
StrongDM. Pass 1 replaced it with a **Play** button. That is the single
biggest omission.

### F. System-level states (4) — none mocked

MFA enforcement gate (full-screen block) · error-boundary fallback ·
session-expired handling · **the toast system** — 141 call sites and no
design at all in pass 1.

### G. Table chrome that pass 1 silently *removed* (7)

Sort · column chooser · export · saved views · refresh + auto-refresh ·
active-filter chips · **pagination**.

All seven exist in `TableControls.jsx` today and are used across six pages.
Dropping them is not a simplification — it is a **regression against the app
being redesigned**, and it is the most serious category on this list.

---

## 3. What this says about pass 1

The route-level work was sound. The failure was scope: I inventoried
**routes**, and an enterprise console's character lives in what those routes
*open*. A beautifully restrained list page whose "Add user" modal still has
the old chrome is worse than not touching either — the mismatch is more
visible than the original.

Second failure: I treated absence as restraint. Removing pagination, sort and
export made the mockups look calmer while making them **less capable than the
product they replace**. That is not design discipline; it is an omission
wearing discipline's clothes.
