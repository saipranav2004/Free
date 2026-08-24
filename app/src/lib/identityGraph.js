// Turns one MemberGraph payload into the levelled, progressively expandable
// model the canvas draws.
//
// WHY THIS EXISTS, AND WHY IT DOES NOT JUST RENDER `nodes` / `edges`
// ─────────────────────────────────────────────────────────────────
// A real account returns around a hundred nodes: one user, one role, a handful
// of policies, then thirty-odd resources and forty-odd credentials hanging off
// them. Drawing all of it produces a hairball, and a hairball answers no
// question at all. Every product that does this well, and the practice
// guidance behind them, converges on the same answer: show one level, let the
// reader open the branch they care about, and keep the rest collapsed with a
// count so they know what they are not looking at.
//
// So the payload is re-nested into four levels, and expansion state decides
// which of them are on screen:
//
//   01 ACCOUNT    the user
//   02 GRANTS     user type, additional roles, direct policies
//   03 POLICIES   the policies each grant carries
//   04 REACH      the resources, credentials and capabilities they match
//
// The nested tree is used rather than the flat nodes/edges pair because the
// tree already carries that parenthood. Re-deriving it from edges would mean
// reconstructing something the API already sent.

export const LEVELS = [
  { index: 0, key: 'account', label: 'Account' },
  { index: 1, key: 'grant', label: 'Grants' },
  { index: 2, key: 'policy', label: 'Policies' },
  { index: 3, key: 'reach', label: 'Reach' },
]

// ── Risk vocabulary ────────────────────────────────────────────────────────
// Tones map onto the app's semantic status tokens, never raw colours, so the
// canvas reads like the rest of the console and survives a theme change.

/**
 * A resource's access mode carries the finding that matters most in a PAM
 * product: standing access is privilege that is true right now and stays true,
 * which is the exact thing time-boxed access exists to remove.
 */
export function accessTone(access, standing) {
  if (standing || access === 'standing_connect') return 'warn'
  if (access === 'all') return 'danger'
  if (access === 'jit_connect') return 'ok'
  return 'muted'
}

export function accessLabel(access, standing) {
  switch (access) {
    case 'standing_connect':
      return 'Standing connect'
    case 'jit_connect':
      return 'JIT connect'
    case 'read':
      return 'Read'
    case 'list':
      return 'List'
    case 'all':
      return 'Full access'
    default:
      return standing ? 'Standing' : 'Access'
  }
}

/** Capability tiers come straight off the payload: 2 is Tier 0 crown jewel. */
export function tierTone(tier) {
  if (tier >= 2) return 'danger'
  if (tier === 1) return 'warn'
  return 'muted'
}

// ── Building the tree ──────────────────────────────────────────────────────

const arr = (v) => (Array.isArray(v) ? v : [])

// ── Capabilities ───────────────────────────────────────────────────────────
//
// THE ONE PART OF THE ANSWER THAT IS NOT IN THE NESTED TREE.
//
// Everything else this file draws comes from `user_type` / `additional_roles` /
// `direct_policies`, because those already carry parenthood. Capabilities do
// not appear there at all, and they are the difference between an account that
// was granted a lot and an account whose authority does not pass through a
// grant in the first place. The root role is the case that matters: the policy
// engine returns a bypass before it consults a single attachment, so a canvas
// drawn only from attachments shows root as an ordinary account with one
// policy on it. That is not a small omission, it is the opposite of the truth.
//
// The API does send them, in the flat `nodes` / `edges` pair the tree docs tell
// you to skip. Only the capability slice of that pair is read here, and only to
// hang it off a node the tree already built: the edge source ids are the same
// `role:<uuid>` / `policy:<uuid>` strings buildTree mints, so attaching is a
// map lookup rather than a second parse of the whole payload.
//
// A backend that sends `nodes: []` produces no capability cards and everything
// else behaves exactly as before.

/**
 * Card titles for the capabilities the backend declares as well-known targets.
 *
 * The payload's own labels are written for an auditor reading a report ("
 * Effective superuser (policy bypass / *:*)") and do not fit a 236px card.
 * The full text is kept on the node and shown in the panel; only the heading
 * is shortened. Anything not in this map falls back to what was sent, so a
 * capability added to the backend later still draws.
 */
const CAPABILITY_LABEL = {
  'capability:superuser': 'Effective superuser',
  'capability:admin_center_write': 'Admin Center write',
  'capability:vault_plaintext_any': 'Decrypt any secret',
  'capability:audit_read_org_wide': 'Org-wide audit read',
}

/** How the account came to hold it, said in the words of the edge that carries it. */
const CAPABILITY_VIA = {
  ROOT_BYPASS: 'Bypasses every policy',
  ADMIN_CENTER: 'Held by the role itself',
  ALLOWS_ACTION: 'Granted by this policy',
}

const CAPABILITY_BADGE = {
  ROOT_BYPASS: 'Bypass',
  ADMIN_CENTER: 'Unmediated',
  ALLOWS_ACTION: 'Granted',
}

/**
 * Every capability the payload hangs off a role or a policy, keyed by that
 * source's node id.
 *
 * Defensive throughout: the arrays are optional in the contract, an edge can
 * name a node that was not sent, and the same capability can be reached twice
 * (root holds admin write both as root and as admin). The first edge to reach
 * one wins, so a card is never drawn twice under the same parent.
 */
export function capabilitiesBySource(graph) {
  const byId = new Map()
  for (const n of arr(graph?.nodes)) {
    if (n?.id) byId.set(n.id, n)
  }
  const out = new Map()
  for (const e of arr(graph?.edges)) {
    const target = byId.get(e?.to)
    if (!target || target.kind !== 'capability') continue
    if (!out.has(e.from)) out.set(e.from, [])
    const list = out.get(e.from)
    if (list.some((x) => x.node.id === target.id)) continue
    list.push({ node: target, edge: e })
  }
  return out
}

/**
 * One capability card, sitting in the column BELOW whatever grants it, so a
 * role's bypass reads beside that role's policies and a policy's capability
 * reads beside the resources that policy matched.
 */
function capabilityNode({ node, edge }, level) {
  const kind = edge?.kind || 'ALLOWS_ACTION'
  return {
    id: node.id,
    level,
    kind: 'capability',
    label: CAPABILITY_LABEL[node.id] || node.label || 'Capability',
    sublabel: CAPABILITY_VIA[kind] || 'Held directly',
    tone: tierTone(node.tier),
    badge: CAPABILITY_BADGE[kind] || 'Capability',
    meta: {
      tier: node.tier ?? 0,
      fullLabel: node.label || '',
      edgeKind: kind,
      standing: edge?.standing !== false,
      finding: edge?.finding || '',
    },
    children: [],
  }
}

/** The capability cards for one source id, already levelled for their parent. */
function capabilitiesFor(caps, sourceId, level) {
  return (caps?.get(sourceId) || []).map((c) => capabilityNode(c, level))
}

/**
 * A policy's reach: everything it matches, flattened into one child list so a
 * policy node has a single expandable set rather than two.
 */
function policyReach(policy) {
  const out = []
  for (const r of arr(policy.matched_resources)) {
    out.push({
      id: `resource:${r.id}`,
      level: 3,
      kind: 'resource',
      label: r.name,
      sublabel: r.type,
      tone: accessTone(r.access, r.standing),
      badge: accessLabel(r.access, r.standing),
      meta: {
        requiresJit: !!r.requires_jit,
        alwaysRecord: !!r.always_record,
        active: r.active !== false,
        standing: !!r.standing,
        access: r.access,
      },
      children: [],
    })
  }
  for (const c of arr(policy.matched_credentials)) {
    out.push({
      id: `credential:${c.id}`,
      level: 3,
      kind: 'credential',
      label: c.name,
      sublabel: c.account || c.type,
      // Revealing a secret in plaintext is the single most damaging call this
      // product exposes, so a credential a policy can reveal is never quiet.
      tone: 'danger',
      badge: 'Reveal',
      meta: { type: c.type, account: c.account },
      children: [],
    })
  }
  return out
}

function policyNode(policy, originLabel, caps, level = 2) {
  const deny = String(policy.effect || '').toLowerCase() === 'deny'
  // Capabilities lead the list. They are at most a couple of cards and they are
  // the highest-signal thing under the parent, so they must never be the ones
  // that fold away behind a "+N more" when a policy matches forty resources.
  const children = deny
    ? []
    : [...capabilitiesFor(caps, `policy:${policy.id}`, level + 1), ...policyReach(policy)]
  return {
    id: `policy:${policy.id}`,
    level,
    kind: 'policy',
    label: policy.name,
    sublabel: originLabel,
    // COLOUR IS SPENT ON RISK, NOT ON STRUCTURE.
    //
    // An allow policy used to be drawn in the accent, which put a saturated
    // card next to every genuinely alarming one and taught the reader that
    // colour on this canvas means nothing in particular. An ordinary policy is
    // just structure and reads grey. A DENY is different and keeps its tone: it
    // restricts rather than grants, and rendering it like an allow is how a
    // reader concludes the account can do something it explicitly cannot.
    tone: deny ? 'ok' : 'muted',
    badge: deny ? 'Deny' : 'Allow',
    meta: {
      effect: policy.effect,
      actions: arr(policy.actions),
      patterns: arr(policy.resource_patterns),
      isSystem: !!policy.is_system,
      description: policy.description || '',
      origin: policy.origin,
    },
    children,
  }
}

function roleNode(role, kind, caps) {
  const policies = arr(role.policies).map((p) => policyNode(p, role.name, caps))
  // Same reasoning as on a policy: an unmediated capability outranks anything
  // it sits beside, so it goes first and is never the card that gets folded.
  const children = [...capabilitiesFor(caps, `role:${role.id}`, 2), ...policies]
  return {
    id: `role:${role.id}`,
    level: 1,
    kind: 'role',
    label: role.name,
    // NOT "Role". The card's tab already says what kind of object this is, so
    // repeating it here spends the only line of qualifying detail the card has
    // on a word the reader has just read. Where the role came FROM is the
    // thing they cannot get anywhere else.
    sublabel: role.is_system ? 'Built in' : 'Custom role',
    tone: 'muted',
    badge: role.is_system ? 'System' : 'Custom',
    meta: {
      description: role.description || '',
      isSystem: !!role.is_system,
      roleKind: kind,
    },
    children,
  }
}

/**
 * Makes every id in the tree unique by scoping it to the path that reached it.
 *
 * THE BUG THIS FIXES, WHICH IS NOT COSMETIC. An object can be reached more than
 * once: `prod-postgres` is matched by both `pam-read-all` and
 * `standard-user-access`, and a policy attached to a role can also be attached
 * straight to the person. Every one of those produced the same `resource:<id>`
 * on two different branches. React Flow keys nodes by id, so the second card
 * was silently dropped, and pathToRoot returned whichever branch it walked
 * into first.
 *
 * On a page whose entire reason to exist is answering THROUGH WHAT, showing one
 * of the two routes and hiding the other is the worst failure available: the
 * missing hop is a real grant somebody still holds after they revoke the one
 * the canvas showed them.
 *
 * The object's own id is kept on `meta.nodeId`, which is what anything that
 * needs to talk about the object rather than the position reads: links out to a
 * record, and the de-duplicated counts in summarise.
 */
function scopeIds(root) {
  const walk = (node, prefix) => {
    const id = prefix ? `${prefix}>${node.id}` : node.id
    return {
      ...node,
      id,
      meta: { ...(node.meta || {}), nodeId: node.id },
      children: (node.children || []).map((c) => walk(c, id)),
    }
  }
  return walk(root, '')
}

/**
 * buildTree turns the API payload into a rooted tree of display nodes.
 *
 * Direct (PBAC) policies are lifted to level 1 beside the roles, because from
 * the account's point of view they ARE a grant: an attachment straight on the
 * user with no role in between. Showing them a level deeper would imply a
 * parent that does not exist.
 */
export function buildTree(graph) {
  if (!graph) return null

  // Read once, up front. Every role and policy node below asks this map whether
  // anything hangs off it that the nested tree does not carry.
  const caps = capabilitiesBySource(graph)

  const grants = []
  if (graph.user_type) grants.push(roleNode(graph.user_type, 'user_type', caps))
  for (const r of arr(graph.additional_roles)) grants.push(roleNode(r, 'additional_role', caps))
  for (const p of arr(graph.direct_policies)) {
    // Level 1, not 2: a direct policy IS a grant from the account's point of
    // view, so it and everything under it sits one column to the left of a
    // policy that hangs off a role.
    const n = policyNode(p, 'Attached directly', caps, 1)
    // Warn, not accent: a policy bolted straight onto a person is a finding
    // in its own right. It does not move when they change team and it is
    // invisible to anyone reviewing role membership.
    grants.push({
      ...n,
      kind: 'direct_policy',
      sublabel: 'Attached to the account',
      tone: n.tone === 'ok' ? 'ok' : 'warn',
    })
  }

  const user = graph.user || {}
  return scopeIds({
    id: `user:${user.id || 'unknown'}`,
    level: 0,
    kind: 'user',
    label: user.username || 'Unknown account',
    sublabel: user.full_name || user.email || '',
    tone: 'accent',
    badge: 'Account',
    meta: {
      email: user.email,
      status: user.status,
      mfaEnabled: !!user.mfa_enabled,
      isProtected: !!user.is_protected,
      fullName: user.full_name,
      id: user.id,
    },
    children: grants,
  })
}

/** Total nodes underneath a subtree, which is what a collapsed card reports. */
export function subtreeCount(node) {
  if (!node?.children?.length) return 0
  let n = 0
  for (const c of node.children) n += 1 + subtreeCount(c)
  return n
}

/**
 * BREADTH DISCLOSURE: how many children of one parent are drawn at once.
 *
 * Collapsing by level already stops the whole graph being drawn at once, but
 * it does nothing about breadth: one policy can match forty resources, and
 * opening it dumps all forty into a single column taller than any screen. The
 * reader then has to scroll a canvas to find out what they even opened, which
 * is the hairball again in one dimension instead of two.
 *
 * Six to start, five per press after that. The first number is what fits
 * beside its parent in one view at a readable zoom; the second is small
 * enough that each press is a deliberate look at a few more things rather
 * than a second flood. What matters more than either is that the card in
 * their place counts what is left ("+210 more"), so a folded branch is
 * never a silent one.
 */
export const REVEAL_INITIAL = 6
export const REVEAL_STEP = 5

/**
 * How many children a parent shows before the rest fold behind "+N more",
 * BY LEVEL rather than one number for the whole tree.
 *
 * One cap for every level was wrong once the canvas started opening two levels
 * on arrival. Six grants beside an account is a comfortable read; six policies
 * beside EACH of six grants is thirty-six cards on screen before the reader
 * has clicked anything, which is the flood the disclosure exists to prevent.
 * Policies are the level that multiplies, so that is the level that gets the
 * tight cap.
 */
const INITIAL_BY_LEVEL = {
  0: 6, // grants under the account
  1: 4, // capabilities and policies under one grant
  2: 6, // resources, secrets and capabilities under one policy
}

export function initialRevealFor(node) {
  return INITIAL_BY_LEVEL[node?.level] ?? REVEAL_INITIAL
}

/** True for the synthetic card that stands in for a parent's hidden children. */
export function isMoreNode(node) {
  return node?.kind === 'more'
}

// ── Filtering ──────────────────────────────────────────────────────────────

/** The exposure cuts the canvas can be narrowed to, all read off real fields. */
export const EXPOSURE_FILTERS = [
  { key: 'all', label: 'All access' },
  { key: 'standing', label: 'Standing only' },
  { key: 'secrets', label: 'Secrets only' },
  { key: 'jit', label: 'JIT gated only' },
]

/** Object kinds that can be switched off, in the order they appear on screen. */
export const KIND_FILTERS = [
  { key: 'role', label: 'Roles' },
  { key: 'direct_policy', label: 'Direct policies' },
  { key: 'policy', label: 'Policies' },
  { key: 'resource', label: 'Resources' },
  { key: 'credential', label: 'Credentials' },
  { key: 'capability', label: 'Capabilities' },
]

export const DEFAULT_FILTERS = {
  exposure: 'all',
  kinds: KIND_FILTERS.map((k) => k.key),
  jitOnly: false,
  recordedOnly: false,
}

export function filtersAreDefault(f) {
  if (!f) return true
  return (
    f.exposure === 'all' &&
    !f.jitOnly &&
    !f.recordedOnly &&
    (f.kinds || []).length === KIND_FILTERS.length
  )
}

/** How many non-default choices are active, for the badge on the Filters button. */
export function activeFilterCount(f) {
  if (!f) return 0
  let n = 0
  if (f.exposure !== 'all') n += 1
  if (f.jitOnly) n += 1
  if (f.recordedOnly) n += 1
  n += KIND_FILTERS.length - (f.kinds || []).length
  return n
}

/**
 * Narrows the tree to the objects a filter asks for, and PRUNES the branches
 * that no longer lead anywhere.
 *
 * The pruning is the point rather than a side effect. "Show me only standing
 * access" is not a request to grey out some leaves; it is the question "which
 * grants hand this account access it never has to ask for", and the only
 * useful answer draws the roles and policies that still reach one and drops
 * the ones that do not. Filtering is applied to the tree BEFORE anything else
 * reads it, so counts, layout and the level rail all describe the same graph.
 *
 * The account itself always survives, so the canvas never goes blank without
 * saying why.
 */
export function filterTree(root, filters) {
  if (!root) return null
  const f = filters || DEFAULT_FILTERS
  if (filtersAreDefault(f)) return root

  const kinds = new Set(f.kinds || [])
  const wantKind = (k) => kinds.has(k)

  const keepReach = (n) => {
    if (n.kind === 'capability') {
      if (!wantKind('capability')) return false
      // The resource-shaped cuts ask questions a capability cannot answer: it
      // has no JIT gate, no recording flag and no safe behind it. Rather than
      // letting it slip through every narrowed view and look like a match, it
      // is shown only when nothing is being narrowed.
      if (f.exposure !== 'all') return false
      if (f.jitOnly || f.recordedOnly) return false
      return true
    }
    if (n.kind === 'credential') {
      if (!wantKind('credential')) return false
      // A credential is not a resource, so the resource-shaped cuts exclude it
      // rather than silently letting it through.
      if (f.exposure === 'standing' || f.exposure === 'jit') return false
      if (f.jitOnly || f.recordedOnly) return false
      return true
    }
    if (n.kind === 'resource') {
      if (!wantKind('resource')) return false
      if (f.exposure === 'secrets') return false
      if (f.exposure === 'standing' && !n.meta?.standing) return false
      if (f.exposure === 'jit' && !n.meta?.requiresJit) return false
      if (f.jitOnly && !n.meta?.requiresJit) return false
      if (f.recordedOnly && !n.meta?.alwaysRecord) return false
      return true
    }
    return true
  }

  const walk = (node) => {
    if (node.level === 3) return keepReach(node) ? { ...node } : null
    if (node.level > 0 && !wantKind(node.kind)) return null

    const had = (node.children || []).length
    const kids = (node.children || []).map(walk).filter(Boolean)
    // A branch that led somewhere and now leads nowhere is not drawn. One that
    // never had children (a deny policy matches nothing by design) is kept.
    if (node.level > 0 && had > 0 && kids.length === 0) return null
    return { ...node, children: kids }
  }

  return walk(root)
}

// ── Depth ──────────────────────────────────────────────────────────────────

/** Depth choices, expressed as the deepest LEVELS index the canvas may draw. */
export const DEPTH_OPTIONS = [
  { key: 1, label: 'Grants' },
  { key: 2, label: 'Policies' },
  { key: 3, label: 'Everything' },
]

/**
 * Flattens the tree down to what is currently visible.
 *
 * A node is visible when its parent is expanded, it falls inside the revealed
 * window for that parent, and it is inside the depth limit. The root is always
 * visible.
 *
 * `revealed` maps a parent id to how many of its children have been asked for.
 * A parent that is not in the map shows REVEAL_INITIAL of them. Where children
 * remain, one synthetic "more" node is emitted in their place.
 *
 * `maxLevel` caps how deep the canvas goes. A node sitting ON the cap is drawn
 * with its downstream count intact but cannot be opened, and says so, which is
 * the difference between a limit and a lie.
 */
export function visibleNodes(root, expanded, revealed = {}, maxLevel = 3) {
  if (!root) return []
  const out = []
  const walk = (node, parentId) => {
    const kids = node.children || []
    const total = subtreeCount(node)
    const atDepthLimit = node.level >= maxLevel && kids.length > 0
    const isExpanded = expanded.has(node.id) && !atDepthLimit
    const shown = isExpanded ? Math.min(revealed[node.id] ?? initialRevealFor(node), kids.length) : 0

    out.push({
      ...node,
      parentId,
      childCount: kids.length,
      shownCount: shown,
      subtreeCount: total,
      isExpanded,
      atDepthLimit,
      isLeaf: kids.length === 0,
    })

    if (!isExpanded) return
    for (let i = 0; i < shown; i += 1) walk(kids[i], node.id)

    const hidden = kids.length - shown
    if (hidden > 0) {
      out.push({
        id: `more:${node.id}`,
        // Same column as the siblings it stands in for, so it reads as one of
        // them rather than as a control floating beside the canvas.
        level: kids[0].level,
        kind: 'more',
        label: `+${hidden} more`,
        tone: 'muted',
        parentOf: node.id,
        parentId: node.id,
        hiddenCount: hidden,
        nextCount: Math.min(REVEAL_STEP, hidden),
        // No edge is drawn to a "more" pill. It is not one of the children, it
        // is a note saying how many are missing, and giving it the same
        // connector as a real object makes it read as one more of them.
        noEdge: true,
        shownCount: 0,
        childCount: 0,
        subtreeCount: 0,
        isExpanded: false,
        atDepthLimit: false,
        isLeaf: true,
        children: [],
      })
    }
  }
  walk(root, null)
  return out
}

/** The node object for an id, searched in the source tree rather than on the canvas. */
export function findNode(root, id) {
  if (!root || !id) return null
  if (root.id === id) return root
  for (const c of root.children || []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

/**
 * The chain of real nodes from the account down to `id`.
 *
 * This is the single most useful thing the panel can show, and the reason the
 * page is a graph rather than a list. An auditor looking at a production
 * database does not want to know only that this account reaches it; they want
 * to know THROUGH WHAT, because that is the thing that can be revoked. The
 * chain names every hop: account, then the grant, then the policy, then the
 * resource it matched.
 */
export function pathNodes(root, id) {
  const ids = pathToRoot(root, id)
  return ids.map((nid) => findNode(root, nid)).filter(Boolean)
}

/** Every id on the path from the root down to `id`, used to light a branch. */
export function pathToRoot(root, id) {
  const chain = []
  const walk = (node, acc) => {
    const next = [...acc, node.id]
    if (node.id === id) {
      chain.push(...next)
      return true
    }
    for (const c of node.children || []) if (walk(c, next)) return true
    return false
  }
  if (root) walk(root, [])
  return chain
}

/** Convenience: the set of ids to auto-expand so `id` is on screen. */
export function expansionFor(root, id) {
  const chain = pathToRoot(root, id)
  // Every ancestor must be open; the node itself is not opened automatically.
  return new Set(chain.slice(0, -1))
}

// ── Estate roll-up ─────────────────────────────────────────────────────────

/**
 * Counts the page leads with. Derived from the tree rather than read off
 * `stats`, because the tree is what is actually on screen and the two must not
 * be able to disagree. `standing` is the one that matters: it is the count of
 * resources this account can reach right now, with nothing to request.
 */
export function summarise(root) {
  const acc = {
    grants: 0,
    roles: 0,
    directPolicies: 0,
    policies: 0,
    resources: 0,
    credentials: 0,
    standing: 0,
    jitGated: 0,
    denyPolicies: 0,
    capabilities: 0,
    // Of those, the ones held by a role outright, with no policy in between.
    unmediated: 0,
    // Set when the account holds the role the policy engine short circuits on.
    // Read off the edge the backend sent rather than off the role's name, so a
    // rename cannot quietly turn the loudest finding on this page off.
    rootBypass: false,
  }
  if (!root) return acc

  const seenResources = new Set()
  const seenCredentials = new Set()
  const seenCapabilities = new Set()

  acc.grants = root.children?.length || 0
  const walk = (node) => {
    if (node.kind === 'role') acc.roles++
    if (node.kind === 'direct_policy') acc.directPolicies++
    if (node.kind === 'policy' || node.kind === 'direct_policy') {
      acc.policies++
      if (String(node.meta?.effect || '').toLowerCase() === 'deny') acc.denyPolicies++
    }
    // Keyed on the object, not the path: a resource reached through two
    // policies is one resource with two routes to it, and counting it twice
    // would overstate the estate this account touches.
    const objectId = node.meta?.nodeId || node.id
    if (node.kind === 'resource' && !seenResources.has(objectId)) {
      seenResources.add(objectId)
      acc.resources++
      if (node.meta?.standing) acc.standing++
      if (node.meta?.requiresJit) acc.jitGated++
    }
    if (node.kind === 'credential' && !seenCredentials.has(objectId)) {
      seenCredentials.add(objectId)
      acc.credentials++
    }
    if (node.kind === 'capability') {
      if (!seenCapabilities.has(objectId)) {
        seenCapabilities.add(objectId)
        acc.capabilities++
      }
      const via = node.meta?.edgeKind
      if (via === 'ROOT_BYPASS' || via === 'ADMIN_CENTER') acc.unmediated++
      if (via === 'ROOT_BYPASS') acc.rootBypass = true
    }
    for (const c of node.children || []) walk(c)
  }
  for (const c of root.children || []) walk(c)
  return acc
}

// ── Layout ─────────────────────────────────────────────────────────────────

// Card geometry. Denser than the first pass on purpose: a card that carries
// four short facts does not need 260px and a 14px title, and the extra size
// was what made a canvas of them read as a slide rather than as a console.
// The card is three stacked bands: state 22, body 40, footer 24.
export const NODE_W = 236
export const NODE_H = 86
// Column gap is smaller than it was because the edges are curves now, not
// right angles. A smoothstep edge needs a horizontal run on each side to turn
// the corner in, so the gap had to hold two elbows and a trunk; a bezier goes
// straight for the target and needs only enough room not to graze the cards.
const COL_GAP = 104
const ROW_GAP = 12

/**
 * The "+N more" affordance is deliberately much smaller than a card.
 *
 * It was a full-size node, and that was the mistake: at card size it reads as
 * another OBJECT in the column, so a reader counting six resources sees seven
 * things and has to read one of them to find out it is a button. Every graph
 * product that does this well makes the collapsed-sibling marker visibly
 * smaller than the thing it stands for, precisely so the two can never be
 * confused: Wiz collapses siblings into a count pill, Neo4j Bloom and
 * Linkurious use a small "+N" chip in the fan, BloodHound a count badge.
 *
 * A third of the height and half the width is enough to say "control, not
 * object" at any zoom, and it keeps the column tight instead of leaving a
 * card-shaped hole at the bottom of every branch.
 */
export const MORE_W = 104
export const MORE_H = 28

/**
 * Distance from one column's left edge to the next.
 *
 * Exported because the column headers are screen furniture drawn OUTSIDE the
 * scene: they have to work out where each column currently sits from the
 * viewport transform, and doing that needs the same stride the layout used.
 */
export const COL_STRIDE = NODE_W + COL_GAP

/**
 * Column layout: one column per level, children stacked beside their parent.
 *
 * Laid out bottom-up so a parent sits at the vertical centre of its own
 * children. That is what makes a fan read as a fan rather than as a list that
 * happens to have lines on it, and it keeps edges from crossing each other in
 * the common case.
 */
const heightOf = (n) => (isMoreNode(n) ? MORE_H : NODE_H)
const widthOf = (n) => (isMoreNode(n) ? MORE_W : NODE_W)

/** Left edge of a node, with the small "+N" pill centred in its column. */
const xOf = (n) => n.level * COL_STRIDE + (NODE_W - widthOf(n)) / 2

export function layout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const childrenOf = new Map()
  for (const n of nodes) {
    if (!n.parentId) continue
    if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, [])
    childrenOf.get(n.parentId).push(n.id)
  }

  const pos = new Map()
  // A running vertical offset rather than a row index, because the rows are no
  // longer all the same height: the "+N" pill is a third of a card, and
  // reserving a full card-height row for it would leave the very gap the
  // smaller shape exists to close.
  let cursorY = 0

  // Depth first. Leaves take the next slot; an interior node is centred on the
  // span of its own children, which is what makes a fan read as a fan rather
  // than as a list that happens to have lines on it. `place` returns the
  // node's CENTRE so mixed heights compose correctly.
  const place = (id) => {
    const node = byId.get(id)
    const h = heightOf(node)
    const kids = childrenOf.get(id) || []

    if (kids.length === 0) {
      const top = cursorY
      cursorY += h + ROW_GAP
      pos.set(id, { x: xOf(node), y: top })
      return top + h / 2
    }

    const centres = kids.map(place)
    const centre = (centres[0] + centres[centres.length - 1]) / 2
    pos.set(id, { x: xOf(node), y: centre - h / 2 })
    return centre
  }

  const root = nodes.find((n) => !n.parentId)
  if (root) place(root.id)
  // Anything orphaned by a race (should not happen) still gets a slot rather
  // than stacking at the origin.
  for (const n of nodes) {
    if (!pos.has(n.id)) {
      pos.set(n.id, { x: xOf(n), y: cursorY })
      cursorY += heightOf(n) + ROW_GAP
    }
  }
  return pos
}
