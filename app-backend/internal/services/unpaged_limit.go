package services

// A CEILING ON THE LIST ENDPOINTS THAT NEVER LEARNED TO PAGE.
//
// Half this codebase pages properly: JIT, audit, sessions, notifications and
// recordings all run their filters through normalisePaging, which clamps a
// caller-supplied page_size to 200. The other half never did. Identity, roles,
// policies and the resource catalogue answer with every row that matches,
// ignoring page and page_size entirely, so one authenticated request pulls a
// whole table into memory and then into the browser. On a tenant with tens of
// thousands of identities that is an availability problem before it is
// anything else, and it is reachable by any administrator.
//
// The real fix is server-side pagination on those four, which changes their
// response envelope and every list page that reads it. This is the part that
// should not wait for that: a hard ceiling, applied in the service so no
// handler can forget it, and a truthful signal when it bites so the console
// can say "this list is capped, narrow it" instead of quietly showing a
// prefix of the data as though it were all of it.
const MaxUnpagedRows = 1000

// capUnpaged trims a slice fetched with a Limit(MaxUnpagedRows+1) probe and
// reports whether more rows existed than were returned.
//
// The extra row is the whole trick: asking for one more than the ceiling is
// what separates "exactly at the limit" from "there is more behind this", and
// it costs one row rather than a second COUNT query.
func capUnpaged[T any](rows []T) ([]T, bool) {
	if len(rows) > MaxUnpagedRows {
		return rows[:MaxUnpagedRows], true
	}
	return rows, false
}
