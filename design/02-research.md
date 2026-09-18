# Phase 2 — Research: what each page should be learning from, and why

Rules for this phase:

- References are chosen **per page, by function** — not "let's all look like Linear".
- For each reference the note says *why it feels premium*, i.e. the mechanism,
  not the mood. "Restrained" is not a mechanism. "One accent, everything else
  neutral, so the accent means 'act here'" is.
- Every extracted principle has to be *applicable to this codebase's data*.
  Patterns that need data our API doesn't return are not extracted.

Sources consulted for specific product behaviour rather than recalled styling:
[Teleport — reviewing access requests](https://goteleport.com/docs/identity-governance/access-lists/reviewing-access-requests/),
[Teleport — JIT access requests](https://goteleport.com/docs/identity-governance/access-requests/),
[Teleport issue #48764 — show approval reason in the UI](https://github.com/gravitational/teleport/issues/48764),
[StrongDM — approval workflows](https://www.strongdm.com/docs/admin/workflows/approval-workflows/),
[CyberArk — PVWA v10+ interface](https://docs.cyberark.com/pam-self-hosted/latest/en/content/landing%20pages/lpversion10interface.htm),
[CyberArk PSM session management](https://secappslearning.com/post/cyberark-psm-session-management-complete-guide-workflow-internal-users-troubleshooting).

---

## Cross-cutting principles (extracted once, obeyed everywhere)

| # | Principle | Where it comes from | Why it reads as premium |
|---|---|---|---|
| P1 | **One accent colour.** Blue means "act here" or "you are here" — nothing else. Every other hue is semantic status (red/amber/emerald) and appears only on state. | Linear, Stripe Dashboard, Vercel | When accent is scarce, the eye finds the action in one saccade. Our current build spends blue on hover borders, card lifts, icon chips and section links, so blue no longer means anything. |
| P2 | **Hierarchy from type and space, not from boxes.** A section is a heading plus air. A border appears only where two things would otherwise be confused. | Linear, Vercel, Stripe | Boxes cost 2 borders + 1 shadow per idea and flatten importance: 10 cards say "10 equally important things". |
| P3 | **One dominant number per view, at most.** Everything else is a compact stat line. | Datadog service pages, Linear Insights | An equal-weight KPI row is a decision the designer declined to make. |
| P4 | **Tables are the product.** Dense, aligned, tabular figures, frozen identity column, right-aligned numerics, one row height. | AWS IAM, Okta, Entra, Datadog | Operators scan columns, not cards. A card grid destroys column alignment, which is the only thing that makes 200 rows readable. |
| P5 | **Contextual toolbar, not a button wall.** Row/bulk actions appear on selection; page actions are one primary + an overflow. | Linear, Okta, Entra | A header with five equal buttons means the product doesn't know what you came to do. |
| P6 | **Never draw a number the backend didn't return.** No trend arrows, no deltas, no sparklines against `GET /admin/stats`. | The existing `KpiStrip.jsx` comment; also Vault/AWS Secrets Manager restraint | In a security console a decorative delta is a lie with an audit trail. |
| P7 | **Four states minimum per view: loading, empty, error, permission-denied.** 403 is a *different* state from 500 and must not offer Retry. | Stripe, Okta | Retrying a 403 forever is the clearest possible signal that nobody designed the failure path. |
| P8 | **Motion is feedback, never flourish.** 120–160 ms, opacity/position only. Nothing lifts on hover. | Linear, Vercel | Hover-lift on a data card is marketing-site vocabulary in an operations tool. |

---

## Per-page research

### `/` Dashboard

**References:** Datadog (service overview), Linear Insights, Okta Admin
Dashboard, CyberArk PVWA v10 landing.

- **Datadog** — the top of a service page is *one* health signal plus a
  time-series; the twenty other numbers live in a compact list below. Premium
  mechanism: the page answers "is this fine?" before it answers "what are the
  numbers?".
- **Linear Insights** — a single chart owns the fold; controls for it sit
  *on* the chart, not in a page-level toolbar. Mechanism: the control is
  adjacent to the thing it changes, so no mental indirection.
- **Okta Admin Dashboard** — the landing page is a work queue ("tasks") first,
  system status second. Mechanism: an admin's landing page is a to-do list,
  not a report.
- **CyberArk PVWA v10** — the redesign's stated goal was "seamless workflows
  and easy access to important information": fewer landing surfaces, more
  direct routes into the workflow.

**Rationale for our page:** an admin opening this console has exactly one job
that cannot wait: **decide the requests that are waiting on them**, and know
immediately if break-glass is live. `pending_approvals` and
`active_breakglass_grants` are actionable; `active_sessions`,
`active_grants`, `active_resources` are inventory. So: pending approvals
becomes the hero with the queue rendered inline beneath it; break-glass gets
an alarm band that only exists when non-zero; the other three collapse to a
one-line stat rail. The greeting goes — it is the least informative element
occupying the most authoritative position.

For the Normal User the same logic gives a different hero: **what expires
soonest**, because that is the only thing on their dashboard with a deadline.

### `/resources` and `/resources/:id`

**References:** Teleport resource catalog, StrongDM resources list, AWS
Systems Manager Fleet, Okta Applications.

- **Teleport** — resources are a dense list with a type glyph, a hostname, and
  a single right-aligned **Connect**. Mechanism: one verb per row; everything
  else is on the detail page.
- **StrongDM** — filters are typed facets (type, tag, status) in a persistent
  rail; the list never leaves the screen while you filter.
- **Okta Applications** — the icon carries type identity; the rest of the row
  is text. Mechanism: icons that encode data are useful; icons that decorate a
  heading are noise (this is our F-13).

**Rationale:** `PAMResource` has 8 display-worthy fields
(`name, resource_type, host, port, connect_mode, requires_jit, always_record,
is_active`) — that is a table, definitively. The card grid is dropped as the
default; the type glyph survives because `ResourceTypeIcon` encodes real data.
`requires_jit` and `always_record` become **filterable facets**, not just
badges, because those two flags are what an operator actually navigates by.

For the detail page, the reference is Teleport's resource view: the connect
affordance is the page's primary and sits in the header, not in a card. Admin
management (store credential, rotate, delete) moves to a clearly separated,
lower-weight zone — CyberArk's PVWA separates "use this account" from
"administer this account" for exactly this reason.

### `/vault`, `/vault/:safeId`, `/vault/:safeId/credentials/:id`

**References:** HashiCorp Vault UI, AWS Secrets Manager, 1Password Business,
CyberArk Safes.

- **HashiCorp Vault** — a path-first breadcrumb (`secret/data/prod/db`) is the
  navigation. Mechanism: hierarchy shown as a path is instantly
  copy-pasteable and matches how the secret is addressed in code.
- **AWS Secrets Manager** — the detail page leads with *rotation state*
  (last rotated, next rotation, interval), then the value, which is behind a
  deliberate reveal. Mechanism: the risky action is the one thing that needs a
  click and a reason.
- **CyberArk Safes** — safe → folder → account, with retention and ownership
  attached to the safe.

**Rationale:** our `Folder` model returns `path` (`/prod-databases/mysql`) and
the UI never uses it. Adopting Vault's path breadcrumb costs nothing and fixes
the flat folder/credential split. On the credential page, `version`,
`last_rotated_at`, `next_rotation_at`, `rotation_interval_days` are all
returned and under-used — Secrets Manager's rotation-first layout is directly
applicable. Reveal stays reason-gated and becomes the single visually dominant
action, with its consequence stated ("this is written to the audit log as
`pam:vault:Reveal`") — that sentence is drawn straight from how Vault and
1Password Business explain audited access.

### `/sessions`

**References:** Teleport session list + session player, CyberArk PSM live
monitoring, Datadog Live Processes.

- **Teleport** — active sessions are a live table; joining/terminating is a
  row action; recordings are a separate, searchable archive. Mechanism: live
  and historical are different pages because they answer different questions.
- **CyberArk PSM** — the operator view emphasises *who is connected to what,
  right now*, with terminate as a first-class control, and monitoring/recording
  status visible per session.
- **Datadog Live Processes** — auto-refresh with a visible "as of" timestamp
  and no layout shift on refresh. Mechanism: liveness you can trust because it
  tells you when it last looked.

**Rationale:** the page already polls every 15 s (`SESSIONS_POLL_MS`, "no push
channel on the backend yet"). Making that visible — an "updated 4s ago" marker
that the poll drives — is honest and is what Datadog does. The KPI strip goes;
the table is the instrument. `is_breakglass` and `recording_required` become
filters, because "show me every unrecorded privileged session" is the actual
operator question. Mine-vs-All stops being a segmented control the user has to
find: a Normal User has no "all", so they never see the control.

### `/jit` (self-service) and `/jit/requests/:id`

**References:** Okta Access Requests, StrongDM approval workflows, Teleport
access requests.

- **StrongDM** — a request is a single object with a status timeline; the
  requester sees who it is waiting on. Mechanism: one object, one lifecycle,
  no correlation work for the user.
- **Okta Access Requests** — "my requests" is a single list where an approved
  request *becomes* the access entry. Mechanism: request and grant are two
  states of one thing.
- **Teleport** — a request carries its reason and, per issue #48764, its
  *approval reason*; the ask is explicitly to show who authorised and why.

**Rationale:** our `AccessGrant` carries `request_id`, and `JITRequest`
carries `grant_id`. The join exists in the payload and the UI ignores it. So
the two tables merge into one lifecycle list: PENDING → PARTIALLY_APPROVED →
APPROVED(grant, counting down) → EXPIRED/REVOKED. The detail page becomes a
timeline, with `decision_reason` and the approvals trail shown — exactly the
gap Teleport filed a bug about.

### `/admin/jit` — approvals queue

**References:** StrongDM approvals, Teleport "Needs Review", CyberArk Dual
Control, Okta Access Requests (approver view).

- **Teleport** — reviewers open a dedicated **Needs Review** list; it is a
  queue, not a filtered table with a status dropdown.
- **StrongDM** — approve/deny is inline in the queue row; the drawer is for
  *why*, not for the action.
- **CyberArk Dual Control** — the second approver is a first-class concept and
  the UI states the confirmation requirement explicitly.

**Rationale:** this is the single highest-value screen in a PAM console and it
currently opens as a generic table. Restructure to the queue model with three
zones, in priority order: **(1) waiting on a second approval** — these need
one specific different person and clear fastest; **(2) new, waiting on
anyone**; **(3) break-glass WAITING** — the waiting-period requests, which are
time-critical and different in kind. `lib/fourEyes.js` already computes every
predicate this needs (`approveBlockedReason`, `approveButtonLabel`,
`approvalProgress`); the redesign is presentational and reuses it unchanged.
Root's "Approve (final)" label already exists there and stays.

### `/admin/identity` and `/admin/identity/:id`

**References:** Okta People / user profile, Azure AD (Entra) user blade, AWS
IAM user summary, JumpCloud.

- **Okta People** — one table, facets for status and type, and a profile page
  organised as *identity → access → activity*, with lifecycle actions
  (suspend, reset, deactivate) grouped and visually separated by risk.
- **Entra user blade** — left rail of sub-sections rather than tabs, so deep
  linking works and no section is hidden behind a click you have to guess.
- **AWS IAM** — "permissions" is shown as *effective* access with the path
  that granted it (role → policy), not just a list of attachments.

**Rationale:** `GET /admin/identity/users/:id` returns
`{ user, access: { roles, policies } }` — attachments only, no effective-
permission resolution, so the AWS "why does this user have this" view is
**not** buildable and is listed under Requires-backend-support rather than
mocked. What is buildable and currently missing weight: the risk separation
Okta uses. Reset password, reset MFA, delegate admin, delete and suspend are
today the same visual weight as "edit full name". They get a distinct,
labelled zone with explicit consequences. `is_protected` and the root-only
delegation rule (verified in `identity_delegation.go`) become visible
explanations, not silent disabled buttons.

### `/admin/roles` and `/admin/policies`

**References:** AWS IAM roles/policies, Okta admin roles, WorkOS RBAC.

- **AWS IAM policy view** — a policy is rendered as *statements*
  (effect → actions → resources), not as a bag of chips. Mechanism: the
  document structure IS the explanation.
- **Okta** — role → what it grants → who holds it, in that order.
- **WorkOS** — a permissions matrix reads faster than nested lists when the
  action set is bounded, and ours is (`COMMON_ACTIONS` in `constants.js`).

**Rationale:** `Policy` returns `effect`, `actions[]`, `resources[]`. Render
it the way IAM does — `ALLOW  pam:vault:Reveal  ON  pam:vault/*` — as
monospace rule lines. That is the same data, read in a fraction of the time.
"Who holds this role" is *not* available from `GET /rbac/roles` →
Requires-backend-support.

### `/admin/mfa-policy`

**References:** Okta authentication policies, Entra Conditional Access,
Duo policy editor.

- **Entra Conditional Access** — every policy edit shows an **impact preview**:
  who this would affect, who would be blocked, before you save. Mechanism: the
  consequence is shown at the moment of the decision.
- **Okta** — rules are ordered and each states its population and its effect in
  one sentence.

**Rationale:** `GET /admin/mfa-policy/compliance` already returns per-account
compliance — "who is gated, who has enrolled, who would be locked out if every
rule were switched to enforce right now" (its own doc comment). That is
Entra's impact preview, already implemented in the API and currently buried
below the rule editor. Promote it to the page's primary. This is the clearest
example in the audit of an endpoint returning more than the UI shows.

### `/audit` and `/admin/audit`

**References:** Datadog Logs Explorer, Teleport session player, CyberArk audit
views, Splunk.

- **Datadog Logs** — a persistent facet rail on the left, a dense stream in the
  middle, a detail panel on the right; the query is always visible and always
  editable. Mechanism: filtering never navigates away from the results.
- **Teleport session player** — a terminal recording plays with a timeline
  scrubber and per-event markers; metadata sits beside, not above.
- **CyberArk audit** — the tamper-evidence claim (chain integrity) is a
  headline compliance statement, not a utility button.

**Rationale:** ours has `AuditFilterBar` above a table — the filters push
results down and results move when the filter opens. Datadog's rail fixes
that. Our `AuditLog` carries `prev_hash`, `entry_hash`, `hash_version`,
`sequence_number`, and `GET /admin/audit/verify` returns a verification —
that is genuine tamper-evidence and deserves the compliance headline
treatment. And `/admin/audit` currently does four jobs; split into
**Events** (Datadog model), **Recordings** (Teleport model), and
**Compliance** (chain verification + report generation) as sibling routes.

### `/admin/vault-ops`

**References:** HashiCorp Vault operator UI, AWS Backup, RDS snapshot restore.

- **AWS Backup / RDS restore** — restore is a guided, confirmed, typed flow
  with the blast radius stated before the button is live.
- **Vault operator UI** — seal/unseal-class operations are visually isolated
  from everything else.

**Rationale:** `POST /vault/restore` takes an `s3_object_key` and overwrites
the vault. It currently sits in a card beside "Backup", same weight. It gets
the AWS treatment: separated, consequence-first, typed confirmation. Backup
history is not listable (`POST /vault/backup` returns a key; nothing lists
keys) → Requires-backend-support.

### `/settings`

**References:** Stripe Dashboard settings, Linear settings, GitHub settings.

- **Linear/Stripe** — settings are *rows in a section*, one control per row,
  label left, control right, description under the label. No card per setting.
- **GitHub** — a "Danger Zone" band groups irreversible account operations.

**Rationale:** 9 cards (plus 5 inside `MfaEnrollment`) become 4 sections of
rows. `SettingRow` + `Switch` already exist and are the right primitive — they
just need to stop being wrapped in a `Card` each.

### `/login`, `/mfa-verify`

**References:** Okta sign-in, Stripe login, Vercel login, 1Password unlock.

- **Stripe/Vercel** — a single centred card on a plain ground. Mechanism: at
  the sign-in moment the product should be quiet and fast, not selling.
- **Okta** — the org's identity (logo, name) is the only branding; everything
  else is the form.
- **1Password unlock** — the MFA step reuses the *identical* frame as the
  password step, so the transition is a content change, not a page change.

**Rationale:** our two auth screens use a marketing hero and a separate colour
system (F-11). Replace with one centred frame on the token background,
identical for both steps, so `/login → /mfa-verify` animates as a content
swap. This also removes the last hard-coded `slate-*`/`white` palette from the
product.

### `/settings` → MFA enrolment · `NotFound` · permission-denied

**References:** Stripe onboarding steppers, GitHub 404, AWS "access denied".

- A 3-step wizard shows *all three steps* with the current one active — the
  user needs to know backup codes are coming before they scan.
- AWS's access-denied page names the permission you lack. Ours silently
  redirects to `/` (F-04). Naming the missing role is both kinder and better
  for support.
