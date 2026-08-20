# Rebuild plan

Written after the note that the last pass produced a repaint rather than a
redesign. This plan states what is true today, where research is genuinely
needed, and the order the rebuild happens in.

---

## Part 1. State of play

### What exists and is trustworthy

| Layer | Status |
|---|---|
| `src/api/*` (13 modules, 88 endpoint calls) | Working. Not to be touched. |
| `src/lib/http.js`, `apiError.js` | Working. Axios client, 401 dedup, blob download, multi shape error normaliser. |
| `src/store/*`, `src/hooks/useTableState.js` | Working. |
| React Query wiring inside every page | Working. This is why "everything must work" is achievable: the mutations already call the right endpoints. |
| `design/01` to `07` | The audit, research, personas, design system, per page redesigns, surface tree, critique. |
| `design/mockups/` | Runnable. Useful as a reference for structure, wrong on two specifics (see below). |
| `app/tools/mock-api/` | 95 route contract server + conformance checker. 38 GET shapes verified against what the client unwraps. |
| Playwright harness | Screenshots every route per persona, measures overflow. |

### What this pass has already changed

- Token layer rewritten (`index.css`, `tailwind.config.js`); shipped `surface-*`/`ink-*` ramps re-pointed at the new palette so nothing was orphaned.
- Type scale raised one step across the board.
- Em dash swept out of all 117 source files (857 occurrences).
- `Button` gained `to` so a navigating button is a real link.
- `AdminRoute` no longer bounces before it knows, and denies with an explanation.
- `QueryState` gained permission denied and offline states.
- Elevation removed from every static surface (123 files); shadow now only on transient surfaces.
- New grid layer: `components/ui/grid.jsx`, `menu.jsx`, `bits.jsx`.
- `ResourceTable` rebuilt on the grid.
- Prettier added, whole tree formatted.

### What is half done and must be finished

- `ResourcesPage` still passes the old props to the new `ResourceTable`, so Connect and Request access are not wired.
- `DensityProvider` is written but not mounted.
- The other six list pages still use the old table.
- Every detail page is still a card wall.

### Two places the approved mockup is wrong

Measured against the published rules (`design/08-table-craft.md`):

1. **32px rows.** Below every cited band (condensed 40 / regular 48 / relaxed 56). Corrected to 44px comfortable, 36px compact.
2. **11px uppercase tracked column headers.** AWS moved label prominence onto weight and colour, not capitals. Corrected to 13px semibold sentence case.

The mockup is a structural reference, not a spec.

---

## Part 2. Where research is required

Research is not a phase that happened. It is a loop that runs three times per
page: **before** (what does the reference do), **during** (does this hold with
real data), **after** (put it side by side with the live product and be
honest).

### Already answered, written up in `design/08-table-craft.md`

- Table row height, cell padding, header type, alignment, dividers, zebra.
- Elevation: shadow only on surfaces that overlap others. Static panels get a stroke.
- Container radius is larger than interior element radius (16 vs 8 in Cloudscape).
- Density must be a global user setting, comfortable by default, compact reduced in increments of 4.
- List page anatomy: breadcrumb, flash, header, actions, filter, preferences, then the table container, then pagination.
- Selection is cleared by sort, pagination and preference changes.

### Open questions, and where each gets answered

| # | Question | Source | When |
|---|---|---|---|
| R1 | How is the app shell built: top bar, side nav, breadcrumb, page header, and what makes it feel anchored rather than floating | Cloudscape app layout; AWS Console; Okta Admin | Before the shell |
| R2 | Detail page: key value pairs vs containers vs tabs, how many columns, where actions live | Cloudscape details page and key-value pairs; Okta user profile | Before Resource and Identity detail |
| R3 | Console dashboard that is not a KPI wall | Okta admin dashboard; AWS Console home; Datadog | Before Dashboard |
| R4 | Approval queue design: what an approver needs in the row vs the drawer | Okta Access Requests; ServiceNow; AWS Systems Manager Change Manager | Before JIT and Admin JIT |
| R5 | Log and audit viewers: filter model, row shape, detail expansion, chain evidence | Okta System Log; AWS CloudTrail; Datadog Logs | Before Audit |
| R6 | Secrets UI: how a vault presents safes, folders, versions, and the reveal moment | HashiCorp Vault UI; AWS Secrets Manager; 1Password Business | Before Vault |
| R7 | Session monitoring and recording playback | Teleport; CyberArk PSM | Before Sessions |
| R8 | Forms and modals: field layout, validation timing, footer action order, destructive confirmation | Cloudscape form and modal; Okta Odyssey | Before the modal pass |
| R9 | Empty, loading, error, denied states | Cloudscape empty states | Alongside foundations |
| R10 | Responsive: how a dense console degrades on tablet and phone | Cloudscape app layout responsive; Okta mobile admin | During each page |
| R11 | Role and policy editors: how permissions are shown without a JSON blob | AWS IAM policy editor; Okta admin roles | Before Roles and Policies |

Each page's entry in `design/10-page-notes.md` will record: what the reference
does, what we took, what we deliberately did differently and why.

---

## Part 3. Foundations, built before any page

1. **Shell** (`AppLayout`, `TopNavbar`, sidebar). R1 first. Dense side nav with live counts, single line top bar, breadcrumb owned by the shell not the page.
2. **Page primitives**: `PageHeader` (title, one line, actions), `Section`, `KeyValueGrid` (this replaces the card wall), `DetailHeader`, `Tabs`.
3. **List chrome**: `CommandBar`, `FilterChip` row, `PreferencesMenu` (density, columns, page size in one gear), `Pagination`, `ActiveFilters`, `BulkBar`.
4. **Grid**: done, plus mount `DensityProvider` at the app root and persist.
5. **Forms**: `Field`, `FieldSet`, `TextInput`, `Select`, `Textarea`, `StrengthMeter`, `ReviewRow`, all sharing one control height and one focus treatment.
6. **Overlays**: `Dialog` (full screen sheet below 640px), `ConfirmDialog`, `Drawer`, `Menu` (done).
7. **States**: `EmptyState`, `NoMatchState`, `ErrorState`, `DeniedState`, `DegradedState`, skeletons that match the geometry of what is loading.

---

## Part 4. Page by page

Order is chosen so that each page reuses what the one before it built.
`LoginPage` and `MfaVerifyPage` are untouched throughout.

| # | Page | Endpoints brought to life | New instrument |
|---|---|---|---|
| 1 | Resources list | `resources/groups`, `resources`, `resources/:id/connect-info`, `resources/:id/sessions`, admin create and delete, store and rotate credential | grid with a real per row action |
| 2 | Resource detail | `resources/:id`, connect info, launch, sessions, audit by resource, admin credential routes | key value grid + tabs |
| 3 | Identity list | `identity/users` | grid, facets, bulk bar |
| 4 | Identity detail | `identity/users/:id`, status, reset password, reset MFA, roles, policies, delegation | key value + tabbed access editor |
| 5 | Sessions | `sessions/mine`, `sessions/:id/end`, admin sessions, kill, recordings, cast, commands | live grid + player |
| 6 | JIT self service | `jit/requests`, `jit/breakglass`, `jit/grants`, cancel | request queue + countdown |
| 7 | JIT request detail | `jit/requests/:id` | four eyes trail |
| 8 | Admin JIT approvals | `admin/jit-requests`, approve, deny, grants, revoke, breakglass, report | approval queue |
| 9 | Vault: safes, safe, credential | safes, folders, credentials, reveal, versions, rotate, password change | tree + reveal flow |
| 10 | Audit and compliance | `audit`, `admin/audit`, verify, report generate | log viewer + drawer |
| 11 | Roles | `rbac/roles`, create, update, delete, attach and detach policy | role editor |
| 12 | Policies | `rbac/policies` CRUD | policy editor |
| 13 | MFA policy | `admin/mfa-policy`, compliance, upsert and delete rule | rule table + coverage |
| 14 | Vault operations | `admin/vault/backup`, `restore` | operation panel |
| 15 | Settings | `auth/me`, MFA setup, backup codes, agent devices and pairing | settings layout |
| 16 | Dashboard | `admin/stats`, jit requests, audit sample | overview, not a KPI wall |
| 17 | NotFound, denied | none | state pages |

### The loop for every page

1. Read the reference product's equivalent screen. Write down the mechanism.
2. Build it against the real hooks. Every control resolves to a real endpoint or it is not drawn.
3. Screenshot at 390, 820, 1440 against the mock API.
4. Put it beside the reference and ask: does this look like the same class of product. If not, name what is missing and fix it before moving on.
5. Record the answer in `design/10-page-notes.md`.

---

## Part 5. Verification

- Contract conformance: `tools/mock-api/contract-check.cjs` on every read endpoint.
- Interaction: Playwright drives every button, form and dialog and asserts the request lands in `requests.log` with the right method, path and body.
- Validation and failure paths: submit invalid, assert the inline error; force 403, 409, 422, network down, assert the state.
- Role enforcement: run every route as root, admin and normal user.
- Responsive: horizontal overflow must be zero at 390, 820, 1440, 1920.
- Console: zero errors, zero React warnings.

## Part 6. Delivery

- `PAM-Console-UI.zip` with the full project tree.
- Design notes updated: `08-table-craft.md`, `09-rebuild-plan.md`, `10-page-notes.md`.
- A short written summary of what changed per page and what each control calls.

## Standing constraints

- No em dash anywhere, including code comments.
- No fabricated field, action or data point. Everything traces to an endpoint in `src/api/`.
- No placeholder function, no console.log stand in, no dead link.
- Text sizes medium to high.
- `LoginPage` and `MfaVerifyPage` are not touched.
