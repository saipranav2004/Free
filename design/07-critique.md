# Step 2 — Critique of pass 1, and what revision 2 changed

Pass 1 is treated here as a draft. Each question below is answered honestly
first, then followed by **what actually changed** — not a note and a shrug.

---

## The verdict up front

Pass 1 would **not** have been mistaken for a mature enterprise product. It
would have been mistaken for a *well-made admin template*. The difference is
specific and it is not aesthetic:

> An enterprise console gives an operator **control over the list** — sort it,
> page it, choose its columns, tighten it, export it, save the view. Pass 1
> gave them a beautiful, restrained, **fixed** list. It looked calmer than the
> original because it did less, and I had labelled that restraint.

Seven controls that exist in `TableControls.jsx` today — sort, column chooser,
export, saved views, refresh/auto-refresh, active-filter chips and pagination —
were absent from every mockup. That is not a style gap. It is a **capability
regression against the product being redesigned**, and it is the single most
serious finding of this pass.

---

## Q1. Mature enterprise product, or nicer student project?

**Honest answer for pass 1: nicer student project, and the tell was density
plus missing controls, not colour.**

Three specific tells:

| Tell | Pass 1 | Revision 2 |
|---|---|---|
| A six-row table followed by 500px of empty page | Rows were 36px with a 32px header, page padding 32px, section gaps 32px | Rows 32px / **26px compact**, header 28px, page padding 24px. ~20 rows per screen instead of ~14 |
| No pagination anywhere | "Showing the first 40 of 144" — a sentence where a control belongs | Real pagination, range read-out, page size in preferences |
| Density specced but never shipped | Compact mode was a line in `04-design-system.md` | A **persisted** preference (`localStorage`), in the gear on every list, applied through React context to every table |

The density point is the one that mattered most. An admin managing hundreds of
privileged accounts does not want a spacious reading experience. They want to
see the whole estate without scrolling, and they want to make it tighter if
that still isn't enough. Pass 1 wrote that sentence and then didn't build the
control.

---

## Q2. With the logo removed, is it distinct from a generic admin template?

**Pass 1: only partly.** The dashboard was distinctive — one hero metric with
the queue inline underneath is not a template layout. The list pages were not:
page header, filter chips, table. That is every admin template ever shipped.

**What changed:** the **command bar**. A single strip under the page title:
primary action left, count in the middle, view utilities right, filters on
their own row beneath. This is the structure AWS Console, Azure Portal and
Salesforce all converge on, and it is why their lists read as *instruments*
rather than *pages with a table on them*. Pass 1 scattered those controls into
the page header, which is exactly why headers kept growing three and four peer
buttons.

Second change: **object-level command bars on detail pages**. The Identity
detail page now carries `Reset password · Reset MFA · Suspend · ⋯` in a strip
under the title (Azure's blade command bar), instead of the same actions
appearing 600px down the page in a "lifecycle" section.

---

## Q3. Single-glance hierarchy — one focal point per screen?

**Pass 1: yes on the dashboard and MFA policy. No on the list pages.** A list
page's focal point should be *the list*, and pass 1 competed with it —
a filter row, a segmented control, a count and a view toggle all at the same
weight above the table.

**What changed:** the command bar gives those three different jobs three
different positions and weights (action / summary / utility), so the eye lands
on the primary action, then the table. The filter chips dropped below the bar
and lost their border weight.

---

## Q4. Is the whitespace doing work, or is it padding to look clean?

**Pass 1: partly the latter, and this is the criticism that stung most.**
`mt-8` between every section and `py-8` on the page was rhythm applied
uniformly — which is the definition of decorative spacing. Uniform gaps
communicate nothing, because grouping needs *contrast* in spacing, not
consistency.

**What changed:** section gaps went 32 → 24, page padding 32 → 24, and the
command bar introduced a **rule** (`border-b` + 12px) that does real grouping
work: everything above it is "what can I do here", everything below is "what is
here". That is one border earning its place, which is the elevation rule the
system already claimed to follow.

---

## Q5. Leftover default patterns that survived unexamined?

Four, found by looking rather than assuming:

1. **Hover-revealed row actions.** Pass 1 hid them until hover "for calm". That
   fails on touch, fails for keyboard, and makes a list un-scannable — you
   cannot see which rows have an action without pointing at each one.
   → Now always visible.
2. **…and then, once visible, six red "Kill" buttons made a red stripe down the
   table's right edge.** A stripe of danger colour on a list of healthy
   sessions means nothing, which is the opposite of what semantic colour is
   for. → Destructive row actions moved into a `⋯` overflow menu (AWS/Azure),
   leaving one quiet glyph per row.
3. **Four peer dropdowns in the toolbar** (Auto · Columns · Density · Export).
   → Consolidated into one **preferences gear** holding density, page size and
   column visibility — AWS's exact pattern — leaving refresh, export and the
   gear.
4. **A native `<select>` with OS chrome** sitting inside a system-styled form.
   Kept deliberately: AWS and Azure both use native selects, and a custom
   listbox is a large accessibility surface to re-implement for a mockup. Noted
   rather than silently "fixed".

---

## Q6. Does the density match how a power user actually works?

**Pass 1: no.** Answered in Q1. One more piece of evidence: the audit stream
showed 40 rows and stopped, with a sentence explaining the cap. A security
analyst working an incident pages through hundreds of events; the sentence was
a substitute for the control.

→ Audit now pages at 50/100/200 with a range read-out, and the page-size cap
is explained where it is *relevant* (the endpoint caps a single call at 500,
so a larger page would take more than one request).

---

## Q7. Against the domain references cited in Phase 2

| Reference | What it does that pass 1 didn't | Fixed in revision 2 |
|---|---|---|
| **Teleport session player** | A replay with a searchable command log and a shared timeline — the whole point of recording a session | The player is built: dual pane, command markers on the scrubber, click-a-command-to-seek, speed, download, SHA-256 shown. Pass 1 had a **Play button** |
| **CyberArk PVWA** | Every privileged operation is confirmed with its consequence and a reason field | 13 confirmations built, four with a required reason, two with type-to-confirm |
| **StrongDM approvals** | Approve/deny inline, with the outcome stated before you commit | The approve dialog now says whether this approval **issues a grant** or is only the first of two — the current build's toast said "Request approved" either way, promising access that didn't exist |
| **Okta People** | Bulk selection with a persistent action bar and per-item results | Select-all, bulk bar, and an honest per-item result (`14 of 17 · 3 failed`) because there is no bulk endpoint |
| **Entra Conditional Access** | Impact preview **at the moment of the edit**, not just on a report page | The MFA rule dialog shows "N accounts would be locked out" inside the editor, and the save button changes to `Save — locks out 2` |

---

## Q8. Against AWS Console / Azure Portal / Salesforce / ServiceNow

This is where the honest gap was widest. What those consoles have that pass 1
lacked, and what was done about each:

| Baseline behaviour | Pass 1 | Revision 2 |
|---|---|---|
| Command bar under the title | ✗ scattered header buttons | ✓ `CommandBar`, on every list and on detail pages |
| Sortable columns with a persistent affordance | ✗ | ✓ `SortTh` — the glyph is always visible so you can tell what's sortable without hovering |
| Pagination with page-size control | ✗ | ✓ |
| Column preferences | ✗ | ✓ in the gear, with locked identity columns |
| Row overflow menu | ✗ | ✓ `⋯` per row |
| Select-all with indeterminate state | ✗ | ✓ |
| Saved views / filter sets | ✗ | ✓ (stored per browser, and it says so — no endpoint persists them) |
| Refresh + "as of" + auto-refresh opt-in | partial (a static marker) | ✓ real control |
| Active-filter chips with clear-all | ✗ | ✓ |
| Global object search in the top bar | ✗ (a decorative ⌘K button) | ✓ palette searches resources, safes and accounts — the real scope `GlobalSearch.jsx` already queries |
| Density control | specced only | ✓ persisted, app-wide |

What was **not** copied, deliberately: AWS's split-panel detail view (our
drawers do the job at this data volume), Azure's pinned-favourites rail
(nothing to pin against), and ServiceNow's list-view editor (no endpoint
persists views server-side).

---

## The mismatch this revision existed to prevent

The prompt named it exactly: *a beautifully redesigned list page whose "Add
User" modal still looks like the old default.* That was true of pass 1 —
**there were no modals at all.** 44 surfaces existed only in the original
codebase.

Revision 2 builds them in the same language: one `Dialog` primitive, one
`ConfirmDialog`, one `Menu`, one toast host, one `Field`/`FieldSet` pair. Every
form uses the same 11px uppercase label, the same 32px control height, the same
error-replaces-hint row so a dialog never reflows as you type.

Two rules the dialog primitive enforces so no caller can drift:

- **Bottom sheet below 640px.** A 544px "centred box" on a 390px phone is the
  classic mismatch — 60% of the screen, with the keyboard over the submit
  button. Every dialog in the product is a full-height sheet on a phone,
  because the primitive decides it, not the caller.
- **Focus trap + Escape + focus restore.** A dialog you can Tab out of is not a
  dialog.

---

## Copy is where a console actually earns trust

The revision changed one thing that isn't visual and matters more than any of
the above: **every destructive confirmation states its real consequence**,
and several of them contradict the assumption a user would otherwise make.

- Suspending an account **does not** kill its live sessions. The dialog says so.
- Revoking a grant **does** kill them, and the API returns how many.
- Deleting an account **does not** delete its audit history — the chain is
  immutable, so past actions stay attributable.
- Deleting a **deny** policy grants access rather than removing it.
- Withdrawing a JIT request **discards an approval already given**, so a
  request that is one approval short is usually worth leaving alone.
- Changing a credential's password on the target **breaks anything else using
  that account** — a cron job, an application — while storing a new version
  does not.

None of that is in the current build's confirmations, and none of it is
guessable from the button label.

---

## What is still weak, stated rather than hidden

1. **The dashboard's activity zone** is still the least distinctive part of the
   product — a bar chart and two lists. It is honest (every value is computed
   from rows the API returned) but it is not a strong idea, and a stronger one
   probably needs the history endpoint listed under Requires-backend-support.
2. **Empty space on short lists.** With six fixture rows a 1000px viewport
   still has room left over. Real estates have hundreds of rows, so this is
   partly a fixture artefact — but a list that knows it is short could offer
   the next useful thing rather than ending.
3. **No keyboard shortcuts beyond ⌘K.** Linear and Superhuman set the bar here
   and the product doesn't reach it. Adding them properly needs an action
   registry, which is the same missing piece that keeps the palette
   navigation-only.
4. **Native selects** keep OS chrome inside system-styled forms. A deliberate
   trade (accessibility surface vs. visual purity), not an oversight.
5. **Icons in the sidebar are conventional, not informational.** A "Dashboard"
   icon encodes nothing. Kept because a collapsed 56px icon rail needs them —
   but by the system's own rule about decorative icons, this is the one place
   it bends.

---

## Verification of revision 2

Not asserted — run:

- **72 route × role combinations** rendered headless: 0 runtime errors.
- **20 dialog triggers** clicked and asserted to open the correct dialog by
  its content, then closed with Escape: all pass.
- **Command palette**: opens on ⌘K/Ctrl-K, searches real objects
  (`pg` → `prod-postgres-primary`), closes on Escape.
- **Recording player**: opens from the recordings tab, renders the transport
  and the command log.
- **Horizontal page overflow** at 390 / 820 / 1280 / 1920: **0px**. (A
  regression was introduced here during the revision — the new top-bar
  controls pushed 19px past a 390px viewport — found by the check, fixed by
  moving the theme toggle into the account menu below 640px.)
