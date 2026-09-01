package config

import "testing"

// An empty password used to truncate the connection string: lib/pq stopped
// reading at "password= " and every keyword after it, dbname included, was
// lost, so the server silently opened a different database. Deployments on
// trust, peer or IAM authentication have no password to set, so this is the
// ordinary case, not an edge one.
func TestDSNKeepsDatabaseNameWithEmptyPassword(t *testing.T) {
	d := DatabaseConfig{
		Host:     "127.0.0.1",
		Port:     5432,
		Name:     "pamprod",
		User:     "pam",
		Password: "",
		SSLMode:  "require",
		Schema:   "pam",
	}
	got := d.DSN()
	want := "host='127.0.0.1' port=5432 user='pam' password='' dbname='pamprod' sslmode='require' search_path='pam'"
	if got != want {
		t.Fatalf("DSN with empty password\n got: %s\nwant: %s", got, want)
	}
}

// A password with a quote or a backslash must not be able to end its own
// value and turn the rest of the string into keywords.
func TestDSNEscapesQuotesAndBackslashes(t *testing.T) {
	d := DatabaseConfig{
		Host:     "db.internal",
		Port:     5432,
		Name:     "pam",
		User:     "pam",
		Password: `p'ass\word`,
		SSLMode:  "require",
		Schema:   "pam",
	}
	got := d.DSN()
	want := `host='db.internal' port=5432 user='pam' password='p\'ass\\word' dbname='pam' sslmode='require' search_path='pam'`
	if got != want {
		t.Fatalf("DSN with quoting\n got: %s\nwant: %s", got, want)
	}
}

// Development migrates without being asked; production only when told.
func TestShouldAutoMigrate(t *testing.T) {
	cases := []struct {
		env  string
		flag bool
		want bool
	}{
		{"development", false, true},
		{"development", true, true},
		{"production", false, false},
		{"production", true, true},
		{"", false, false}, // unset means production, which is the fail-closed side
	}
	for _, c := range cases {
		cfg := &Config{}
		cfg.Server.Env = c.env
		cfg.Database.AutoMigrate = c.flag
		if got := cfg.ShouldAutoMigrate(); got != c.want {
			t.Errorf("env=%q flag=%v: got %v, want %v", c.env, c.flag, got, c.want)
		}
	}
}
