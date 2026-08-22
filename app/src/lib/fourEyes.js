// ---------------------------------------------------------------------------
// Four-eyes (dual control), every rule the console needs, in one place
// ---------------------------------------------------------------------------
// WHAT CHANGED IN THE API. A STANDARD JIT request used to be settled by one
// approval. It is now settled by TWO, from two DIFFERENT people:
//
//   Admin A approves  → status PARTIALLY_APPROVED, NO grant
//   Admin A again     → HTTP 409 "duplicate approver"
//   Admin B approves  → status APPROVED, grant issued
//   Root approves     → status APPROVED, grant issued, at any point
//   Anyone denies     → status DENIED (deny never waits for a second person)
//
// WHY THIS FILE EXISTS. Four surfaces show approvals (the queue, the queue's
// drawer, the requester's detail page, the dashboard) and all four have to
// agree on the same three judgements: is this request still open, may I press
// Approve, and what did the server just tell me. Re-deriving that per screen
// is how one screen ends up offering a button the API will refuse.
//
// WHAT THIS FILE WILL NOT DO. It never decides quorum itself. The server owns
// that, it is the only party that knows every approval row and the request's
// TTL. Everything here is either reading what the server said or predicting a
// refusal well enough to grey out a button; a wrong prediction costs a
// disabled button, never a wrongly issued grant.

import { JIT_STATUS, APPROVER_RANK, isTerminalJitStatus } from '../config/constants'

// Standard four-eyes needs two distinct approvers. Root short-circuits it.
export const REQUIRED_APPROVALS = 2

// ---------------------------------------------------------------------------
// Reading the payload
// ---------------------------------------------------------------------------

// The approvals trail only exists on the ADMIN detail endpoint
// (GET /admin/jit-requests/:id → { request, grant, audit_trail, approvals }).
// It is absent from every list response and from the requester's own detail
// route, so "no approvals array" means "not told", never "nobody approved".
export function approvalsOf(detail) {
  const raw =
    (Array.isArray(detail?.approvals) && detail.approvals) ||
    (Array.isArray(detail?.request?.approvals) && detail.request.approvals) ||
    null
  if (!raw) return null
  return [...raw].sort(
    (a, b) => new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime()
  )
}

export function isApproval(row) {
  return String(row?.decision || '').toLowerCase() === 'approved'
}

export function isDenial(row) {
  return String(row?.decision || '').toLowerCase() === 'denied'
}

export function approverIdOf(row) {
  return row?.approver_user_id || row?.user_id || null
}

export function isRootApproval(row) {
  return Number(row?.approver_rank) >= APPROVER_RANK.ROOT
}

// The signed-in user's id. /auth/me is not pinned to one field name across
// deployments, so probe rather than assume, an id we fail to read would
// silently disable every duplicate-approver guard below.
export function viewerIdOf(user) {
  return user?.id || user?.user_id || user?.uid || user?.sub || null
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * How far through dual control this request is.
 *
 * `known` is false when we only have the request row (a list response) and no
 * trail, the counts are then inferred from `status` alone, which is enough
 * to say "1 of 2" but not enough to say WHO.
 *
 * @returns {{
 * known: boolean, given: number, required: number, remaining: number,
 * quorum: boolean, finalisedByRoot: boolean, deniedBy: object|null,
 * }}
 */
export function approvalProgress(request, approvals) {
  const status = request?.status
  const rows = Array.isArray(approvals) ? approvals : null
  const approved = rows ? rows.filter(isApproval) : null
  const denial = rows ? rows.find(isDenial) || null : null

  // Inferred from status when the trail was not fetched.
  const inferred =
    status === JIT_STATUS.PARTIALLY_APPROVED ? 1 : status === JIT_STATUS.APPROVED ? REQUIRED_APPROVALS : 0

  const given = approved ? approved.length : inferred
  const finalisedByRoot = approved ? approved.some(isRootApproval) : false
  const quorum = status === JIT_STATUS.APPROVED || finalisedByRoot

  return {
    known: !!rows,
    given,
    required: REQUIRED_APPROVALS,
    // Root makes one approval enough, so "remaining" is zero the moment
    // quorum is reached however it was reached.
    remaining: quorum ? 0 : Math.max(0, REQUIRED_APPROVALS - given),
    quorum,
    finalisedByRoot,
    deniedBy: denial,
  }
}

/** One short phrase for a progress pill: "1 of 2 approvals". */
export function progressLabel(progress) {
  if (!progress) return ''
  if (progress.finalisedByRoot && progress.given <= 1) return 'Approved by root, final'
  return `${progress.given} of ${progress.required} approvals`
}

// ---------------------------------------------------------------------------
// May this viewer approve?
// ---------------------------------------------------------------------------

/**
 * Why the Approve button must be disabled, or null when it may be pressed.
 * Deliberately returns the SENTENCE, not a boolean, every caller renders it
 * (as a tooltip or an inline note), and a bare `false` teaches the approver
 * nothing about why the console will not let them act.
 *
 * @param {object} request
 * @param {object[]|null} approvals trail, or null when it was not fetched
 * @param {{id: string|null, isRoot: boolean}} viewer
 */
export function approveBlockedReason(request, approvals, viewer) {
  if (!request) return 'Nothing selected.'
  if (isTerminalJitStatus(request.status)) return 'This request has already been decided.'
  if (request.status === JIT_STATUS.WAITING) {
    return 'Break-glass does not go through approval, it runs a cooling-off period instead.'
  }

  const me = viewer?.id || null

  // Self-approval is a 403 on the server. Catching it here keeps an approver
  // from being told "permission denied" for what is really a rule.
  const requester = request.requester_user_id || request.user_id || null
  if (me && requester && me === requester) {
    return 'You raised this request, separation of duty means someone else has to decide it.'
  }

  // Duplicate approver is a 409. Only checkable when the trail is loaded AND
  // we know who we are; either unknown and we let the server answer.
  if (Array.isArray(approvals) && me) {
    const mine = approvals.find((a) => isApproval(a) && approverIdOf(a) === me)
    if (mine) return 'You approved, awaiting a second approver.'
  }

  return null
}

/** The Approve button's own words, which differ for root. */
export function approveButtonLabel(request, progress, viewer) {
  if (viewer?.isRoot) return 'Approve (final)'
  if (request?.status === JIT_STATUS.PARTIALLY_APPROVED || (progress?.given ?? 0) >= 1) {
    return 'Give second approval'
  }
  return 'Approve'
}

/** What pressing Approve will actually do, said before it is pressed. */
export function approveConsequence(request, progress, viewer) {
  if (viewer?.isRoot) {
    return 'You are root: your approval is final on its own. The grant is issued immediately and access starts now.'
  }
  const given = progress?.given ?? 0
  if (given >= 1 || request?.status === JIT_STATUS.PARTIALLY_APPROVED) {
    return 'This is the second approval. The grant is issued immediately and access starts now.'
  }
  return 'This records the first of two approvals. No access exists until a second, different admin (or root) also approves.'
}

// ---------------------------------------------------------------------------
// Reading the approve response
// ---------------------------------------------------------------------------

/**
 * POST …/approve answers in one of two shapes and the caller cannot know
 * which until it arrives:
 *
 *   A  { request, status: 'PARTIALLY_APPROVED', next }  , no grant yet
 *   B  { request, grant, expires_at }                   , quorum, grant issued
 *
 * Telling them apart by `data.grant` alone would be fragile (a future shape
 * could carry a null grant), so the status is read first and the grant only
 * confirms it.
 */
export function readApproveResult(data) {
  const request = data?.request || null
  const status = data?.status || request?.status || null
  const grant = data?.grant || null
  const partial = status === JIT_STATUS.PARTIALLY_APPROVED || (!grant && status !== JIT_STATUS.APPROVED)

  return {
    partial,
    request,
    grant,
    status,
    expiresAt: data?.expires_at || grant?.expires_at || null,
    next: userFacingNext(data?.next),
  }
}

/**
 * The API's `next` field is written for API CONSUMERS, not for end users, and
 * it is not consistent about which it is. Compare the two the JIT handler
 * returns:
 *
 *   "A second, different admin (or root) must approve to issue the grant."
 *   "Awaiting approver decision. Poll GET /api/v1/pam/jit/requests/<uuid>"
 *
 * The first is a sentence a person should read. The second is an instruction
 * to a program, and putting it in a toast showed a normal user an HTTP verb, a
 * route and a raw id after they clicked Request access.
 *
 * Rendering a machine-facing hint as human copy is the CLIENT's mistake, not
 * the server's: `next` is a legitimate affordance for a programmatic caller,
 * and it is this console that chose to treat it as prose. So the console
 * checks before it trusts it. Anything carrying an HTTP method, an API path,
 * or a bare identifier is dropped in favour of the caller's own wording.
 *
 * Returns null when the string is not fit for a person, so callers fall back
 * to copy they control.
 */
export function userFacingNext(next) {
  const text = typeof next === 'string' ? next.trim() : ''
  if (!text) return null
  // An HTTP verb, an API route, a curl-ish hint, or a UUID: all machine facing.
  if (/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(text)) return null
  if (/\/api\/|\/v\d+\/|https?:\/\//i.test(text)) return null
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return null
  return text
}

/** The toast text for whichever of the two shapes came back. */
export function approveResultMessage(result) {
  if (!result) return 'Approval recorded'
  if (result.partial) return 'Approval recorded, a second, different approver is still needed'
  return 'Approved, time-boxed grant issued'
}

// ---------------------------------------------------------------------------
// Errors that mean "the world moved under you"
// ---------------------------------------------------------------------------
// Both arrive as 409 and both mean the same thing to the person at the
// screen: stop, re-read, do not retry the same click. They are separated
// only so the message can name which one happened.

function messageOf(err) {
  const raw = err?.response?.data?.error
  const text = typeof raw === 'string' ? raw : raw?.message || ''
  return String(text).toLowerCase()
}

export function isDuplicateApproverError(err) {
  if (err?.response?.status !== 409) return false
  const m = messageOf(err)
  return m.includes('duplicate') || m.includes('already approved')
}

export function isSelfApprovalError(err) {
  if (err?.response?.status !== 403) return false
  const m = messageOf(err)
  return m.includes('self') || m.includes('own request') || m.includes('separation')
}

export function isStaleStateError(err) {
  return err?.response?.status === 409
}

/**
 * The message to show for a failed approve/deny. Falls back to the server's
 * own text for anything not specific to four-eyes, `apiErrorMessage` is
 * still the right answer for every other failure, and this only overrides
 * the two the server states tersely.
 */
export function approvalErrorMessage(err, fallback) {
  if (isDuplicateApproverError(err)) {
    return 'You have already approved this request, a different admin (or root) has to give the second approval.'
  }
  if (isSelfApprovalError(err)) {
    return 'You cannot approve your own request. Someone else has to decide it.'
  }
  if (isStaleStateError(err)) {
    return 'Someone else has already acted on this request, refreshed with the current state.'
  }
  return fallback
}
