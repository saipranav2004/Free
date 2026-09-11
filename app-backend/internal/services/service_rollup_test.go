package services

import "testing"

// widestScope decides what a row says about reach, so its two jobs are worth
// pinning: find the pattern that covers the most, and call out the one that
// covers everything. A count alone hides the difference between "three narrow
// paths" and "three paths, one of which is *".
func TestWidestScopePicksTheShallowestPattern(t *testing.T) {
	cases := []struct {
		name         string
		joined       string
		wantWildcard bool
		wantWidest   string
	}{
		{"empty", "", false, ""},
		{"single", "prod/deploy/keys", false, "prod/deploy/keys"},
		{
			// A shorter pattern is a shallower prefix and therefore reaches
			// further, so it wins even though it sorts later.
			"shallowest wins", "prod/billing/db,prod/*,prod/billing/api",
			false, "prod/*",
		},
		{"bare star anywhere", "prod/billing/db,*", true, "*"},
		{"double star", "**", true, "**"},
		{"star slash star", "*/*", true, "*/*"},
		{"blank entries ignored", " ,prod/a, ,prod/bb", false, "prod/a"},
		{"whitespace trimmed", "  prod/deploy/keys  ", false, "prod/deploy/keys"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			wildcard, widest := widestScope(c.joined)
			if wildcard != c.wantWildcard {
				t.Errorf("wildcard: got %v, want %v", wildcard, c.wantWildcard)
			}
			if widest != c.wantWidest {
				t.Errorf("widest: got %q, want %q", widest, c.wantWidest)
			}
		})
	}
}

// A wildcard short-circuits: once one grant reads everything, nothing about
// the others changes the answer, and the row has to say so whatever order the
// database returned them in.
func TestWidestScopeWildcardWinsFromAnyPosition(t *testing.T) {
	for _, joined := range []string{"*,prod/a,prod/b", "prod/a,*,prod/b", "prod/a,prod/b,*"} {
		wildcard, widest := widestScope(joined)
		if !wildcard {
			t.Errorf("%q: got wildcard false, want true", joined)
		}
		if widest != "*" {
			t.Errorf("%q: got widest %q, want \"*\"", joined, widest)
		}
	}
}
