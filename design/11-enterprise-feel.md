# What is missing, and why Amazon, Okta and Entra feel different

The console looks right. This is about the gap between *looking* enterprise and
*behaving* enterprise, which is where the feel actually comes from.

The method: for each mechanism, name the product that does it, say what it buys,
then check whether we have it.

---

## The finding, in one line

We were strong on **surface** (density, type scale, tokens, restraint) and weak
on **statefulness**: the console did not remember where you were, could not tell
anyone else where you were, and did not react until the server did.

Those three are most of what separates a console from a dashboard.

---

## 1. View state was invisible to the address bar  ← fixed this pass

**What they do.** Filter the AWS EC2 instance list and the filter is in the URL.
Search Okta's System Log and the whole query is in the URL. Filter Entra's user
list, same. This is not incidental: it is what makes "here, look at this"
possible in a chat message, and it is why a reload never loses your place.

**What we did.** Search, filters, sort and page lived in React state. A filtered
view could be reached but not sent, not bookmarked, and not survived a reload.
Every list in the product had this.

**Fixed.** `useTableState` now writes view state to the query string and seeds
from it at mount, on Resources, Sessions, Vault safes, Identity, Roles and
Policies. Identity's server-side search is wired in too.

The split is deliberate:

| Goes in the URL | Stays in localStorage |
|---|---|
| search, filters, sort, page | page size, density, visible columns |
| **where you are** — shareable | **how you like tables** — yours |

Sending your density preference to a colleague would impose it on them. Sending
a filter is the entire point.

Verified cold: clicking the Locked facet produces
`/admin/identity?sort=username&dir=asc&status=LOCKED`, and loading that URL in a
fresh browser with no stored state renders exactly the one locked account.

---

## 2. Nothing happens until the server answers

**What they do.** Linear, Vercel and Stripe apply the change to the screen
immediately and roll it back if the call fails. The work feels done because on
screen it is done.

**What we do.** Every mutation is a spinner until the round trip lands. On a
healthy network that is 200ms of nothing; on a slow one it reads as a dead
button, which is what makes people click twice.

**Where it would pay.** Approve/deny in the JIT queue, terminate a session,
toggle a switch. These are single-field state changes with an obvious rollback,
which is exactly the safe case for optimistic updates.

**Not done this pass.** It changes failure behaviour on destructive security
actions, so it wants its own change with its own verification, not a footnote to
a settings redesign.

---

## 3. Row affordance stopped at the link  ← fixed this pass

**What they do.** In Okta's People list and Entra's user blade the whole row is
the target, with the chevron as a hint rather than the only door.

**What we had.** The username was a link; the rest of the row was inert. The
click target was roughly 15% of a 44px band that looks entirely clickable.

**Fixed.** `Tr` takes `to` (navigate) or `onClick` (open the peek panel) and the
whole row responds. It steps aside for anything that already does something,
never swallows a modifier click, and ignores a click that merely ended a text
selection. The row is deliberately not a tab stop: the identity cell already
holds a real link, so adding one would put two stops on every record.

Verified: clicking a row checkbox selects without navigating; clicking dead
space in the row opens the record.

---

## 4. Time is shown one way at a time

**What they do.** CloudWatch and the Okta log show relative time with the exact
timestamp on hover. Relative for scanning, absolute for evidence.

**What we have.** Mostly right already (`Last sign-in 6h ago` carries a `title`
with the timestamp). Not consistent everywhere.

---

## 5. Empty and zero read the same

**What they do.** Okta distinguishes "no accounts exist yet" (onboarding, with a
create button) from "nothing matched that filter" (a clear-filters button).

**What we have.** Correct on the rebuilt lists, which is why the distinction
appears at all. Worth holding as every new list is added.

---

## Per page

| Page | Strongest | Weakest |
|---|---|---|
| Dashboard | Fact rail beats the old KPI wall | Panels do not deep-link into their filtered list |
| Resources | Dense grid, honest facets, whole-row click | No optimistic connect |
| Vault safes / safe | Folder rail filters rather than duplicating | Credential table still the least dense |
| Sessions | Live dot earns its animation | Terminate waits on the round trip |
| JIT (self) | Countdown is the right primary fact | No optimistic cancel |
| JIT approvals | Four-eyes progress is genuinely good | Approve/deny not optimistic; two tables, so no URL sync |
| Identity list | Best table in the product, whole-row click | Bulk actions still need a batch endpoint |
| Identity detail | Fact rail + tabs is the right shape | Access tab still carries stat tiles |
| Audit | Filters are real | Export does not carry the filter into the filename |
| Settings | Rebuilt this pass, rail + rows | — |

---

## Order of work, by payoff per unit of risk

1. ~~URL-synced view state~~ — **done this pass**, whole-product effect
2. ~~Whole-row click targets~~ — **done this pass** on Identity and Resources
3. Optimistic updates on approve / deny / terminate — biggest perceived speed
   gain, needs its own verification pass
4. Dashboard panels deep-link into the filtered list they summarise, now that
   filters are URL-addressable
5. Consistent relative-plus-absolute time
