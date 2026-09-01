package services

import "testing"

// Setting a password is taking the account, so the rule has to be the same one
// that guards clearing a second factor. It was not: the reset endpoint checked
// only the new password's length, so any administrator could set root's
// password and sign in as root. On a fresh install, where root has not enrolled
// a factor yet, that is a complete takeover by anyone holding admin.
func TestOnlyRootMayResetAPrivilegedAccountsPassword(t *testing.T) {
	root := []string{"root"}
	admin := []string{"admin", "user"}
	user := []string{"user"}

	cases := []struct {
		name      string
		actor     []string
		target    []string
		protected bool
		want      bool
	}{
		{"admin cannot reset root", admin, root, false, false},
		{"admin cannot reset the protected bootstrap account", admin, user, true, false},
		{"admin cannot reset another admin", admin, admin, false, false},
		{"admin can reset a standard user", admin, user, false, true},
		{"root can reset root", root, root, false, true},
		{"root can reset an admin", root, admin, false, true},
		{"a standard user can reset nobody", user, user, false, false},
		{"no roles at all is refused, not defaulted to allow", nil, user, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := CanResetPassword(c.actor, c.target, c.protected); got != c.want {
				t.Fatalf("CanResetPassword(%v, %v, protected=%v) = %v, want %v",
					c.actor, c.target, c.protected, got, c.want)
			}
		})
	}
}
