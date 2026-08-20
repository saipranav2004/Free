// ---------------------------------------------------------------------------
// Input rules for identity forms
// ---------------------------------------------------------------------------
// Kept in one file so the create-user modal, any future edit form, and the
// zod schemas that back them can never disagree about what a valid username
// is. Each rule exports three things: a test, a sanitizer for what the field
// accepts WHILE TYPING, and the message shown when it fails.
//
// Sanitize-on-type vs validate-on-submit: for these two fields the character
// set is small and unambiguous, so the field simply refuses characters that
// can never be valid (typing "!" in a username does nothing) rather than
// letting them in and scolding afterwards. Length and shape rules, too
// short, leading dot, all-numeric, are still reported as messages, because
// silently deleting a character the user could legitimately be mid-way
// through typing is worse than telling them.

// --- Full name -------------------------------------------------------------
// Letters and spaces only, per the rule given: no digits, no punctuation.
// Unicode-aware (\p{L}) so accented and non-Latin names aren't rejected ,
// "alphabets only" is a rule about digits and symbols, not about English.
const NAME_STRIP = /[^\p{L}\s]/gu

export const fullNameRules = {
  sanitize: (raw) =>
    String(raw || '')
      .replace(NAME_STRIP, '')
      .replace(/\s{2,}/g, ' ')
      .slice(0, 80),
  test: (v) => {
    const s = String(v || '').trim()
    if (!s) return true // optional field, empty is fine
    return /^[\p{L}]+(?:\s[\p{L}]+)*$/u.test(s) && s.length >= 2
  },
  message: 'Letters and single spaces only, no numbers or symbols.',
  hint: 'Letters and spaces only.',
}

// --- Username --------------------------------------------------------------
// Instagram-style: lowercase letters, digits, underscores and periods, no
// spaces, no leading/trailing period, no consecutive periods. Uppercase is
// folded to lowercase as you type rather than rejected, typing "Alice" and
// getting "alice" is what every platform with this rule does.
const USERNAME_STRIP = /[^a-z0-9._]/g

export const usernameRules = {
  sanitize: (raw) =>
    String(raw || '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(USERNAME_STRIP, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^\./, '')
      .slice(0, 30),
  test: (v) => {
    const s = String(v || '')
    if (s.length < 3 || s.length > 30) return false
    if (!/^[a-z0-9._]+$/.test(s)) return false
    if (/^[._]/.test(s) || /[.]$/.test(s)) return false
    if (/\.{2,}/.test(s)) return false
    if (/^\d+$/.test(s)) return false // all-digits reads as an ID, not a name
    return true
  },
  message:
    '3–30 characters: lowercase letters, numbers, underscores and periods. No spaces, and it can’t start or end with a period.',
  hint: 'Lowercase letters, numbers, _ and ., no spaces.',
}

// --- Password --------------------------------------------------------------
// The backend's floor is 10 characters (identity_handler.go). The meter below
// is advisory only: it never blocks a submit the server would have accepted,
// because a frontend inventing extra password rules just produces accounts
// that can't be created for reasons the API never stated.
export const PASSWORD_MIN = 10

export function passwordStrength(pw) {
  const s = String(pw || '')
  if (!s) return { score: 0, label: 'Enter a password', tone: 'ink' }
  let score = 0
  if (s.length >= PASSWORD_MIN) score++
  if (s.length >= 16) score++
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++
  if (/\d/.test(s)) score++
  if (/[^A-Za-z0-9]/.test(s)) score++
  if (s.length < PASSWORD_MIN) return { score: 1, label: `At least ${PASSWORD_MIN} characters`, tone: 'red' }
  if (score <= 2) return { score: 2, label: 'Weak, add length or variety', tone: 'amber' }
  if (score === 3) return { score: 3, label: 'Fair', tone: 'amber' }
  if (score === 4) return { score: 4, label: 'Strong', tone: 'emerald' }
  return { score: 5, label: 'Very strong', tone: 'emerald' }
}

// Generates a password that satisfies the policy above without the ambiguous
// glyph pairs (O/0, l/1) that make a shared credential unreadable over a
// call, the same reason PAM products generate rather than let people type.
export function suggestPassword(len = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'
  const bytes = new Uint32Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

// --- Role names -------------------------------------------------------------
// A role name is an IDENTIFIER the policy engine matches on, not a display
// label, it travels into assignRole/removeRole payloads and into audit
// strings. So it gets identifier shape (lowercase, digits, hyphen,
// underscore) sanitized as you type, exactly like the username field:
// "Database Admins" becomes "database-admins" while you type rather than
// being accepted and then rejected by the server.
const ROLE_STRIP = /[^a-z0-9_-]/g

export const roleNameRules = {
  sanitize: (raw) =>
    String(raw || '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(ROLE_STRIP, '')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]/, '')
      .slice(0, 64),
  test: (v) => {
    const s = String(v || '')
    if (s.length < 2 || s.length > 64) return false
    if (!/^[a-z0-9_-]+$/.test(s)) return false
    if (/^[-_]/.test(s) || /[-_]$/.test(s)) return false
    return true
  },
  message:
    '2–64 characters: lowercase letters, numbers, hyphens and underscores. No spaces, and it can’t start or end with a separator.',
  hint: 'Lowercase identifier, spaces become hyphens as you type.',
}

// --- Policy names -----------------------------------------------------------
// Unlike a role name, a policy name is a LABEL: it is referenced by id
// everywhere that matters, and it is read by auditors. So it stays free text
// and only rejects the things that break downstream, empty, control
// characters, or absurd length.
export const policyNameRules = {
  test: (v) => {
    const s = String(v || '').trim()
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    return s.length >= 3 && s.length <= 120 && !/[\u0000-\u001F\u007F]/.test(s)
  },
  message: 'Give the policy a descriptive name of 3–120 characters.',
  hint: 'Written for whoever audits this later, “Read production databases”, not “policy-4”.',
}

// --- Safe / credential names ----------------------------------------------
// Vault object names end up in audit strings, report filenames and CLI
// arguments, so control characters and leading/trailing whitespace are
// stripped rather than stored.
export const objectNameRules = {
  sanitize: (raw) =>
    String(raw || '')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .slice(0, 120),
  test: (v) => String(v || '').trim().length >= 2,
  message: 'Give this a name of at least 2 characters.',
}
