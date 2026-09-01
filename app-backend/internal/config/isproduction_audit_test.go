package config

import "testing"

// The default must be production, and anything that is not a recognised
// development name must also be production. Both directions matter: the first
// is what stopped an install from publishing the dev test-login route by
// omission, the second is what stops a typo from doing the same.
func TestIsProductionFailsClosed(t *testing.T) {
	prod := []string{"production", "prod", "", "  ", "Production", "prodction", "staging", "anything"}
	dev := []string{"development", "dev", "local", "test", "DEVELOPMENT", " dev "}
	for _, e := range prod {
		c := &Config{}
		c.Server.Env = e
		if !c.IsProduction() {
			t.Errorf("env %q must be treated as production", e)
		}
	}
	for _, e := range dev {
		c := &Config{}
		c.Server.Env = e
		if c.IsProduction() {
			t.Errorf("env %q must be treated as development", e)
		}
	}
}
