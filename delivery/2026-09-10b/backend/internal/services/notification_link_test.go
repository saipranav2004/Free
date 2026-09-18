package services

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every notification link names the tab it is about.
//
// A notification is a pointer at one thing that just happened. Landing the
// reader on a page's default tab and leaving them to find it undoes the point
// of sending it, and it is worst exactly where it matters most: "Break-glass
// access raised" asks somebody to revoke an elevation before a waiting period
// runs out, and it used to open the requests queue.
//
// Asserted over the SOURCE rather than by calling each notifier, because these
// links are written at eight separate call sites across two packages and the
// failure mode is a ninth being added without one. A test that only covered
// the eight would pass on the day the ninth arrives.
func TestEveryJitNotificationLinkNamesItsTab(t *testing.T) {
	// Path -> the console routes that need a tab. A route is listed here only
	// if the page it names actually has tabs; /jit/requests/<id> opens one
	// request and has none, so it is not in this set.
	tabbed := map[string]bool{"/jit": true, "/admin/jit": true, "/admin/audit": true}

	linkRe := regexp.MustCompile(`Link:\s*"([^"]*)"`)
	files := []string{
		filepath.Join("jit_service.go"),
		filepath.Join("..", "api", "handlers", "jit_handler.go"),
	}

	checked := 0
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		for _, m := range linkRe.FindAllStringSubmatch(string(src), -1) {
			link := m[1]
			path, query, _ := strings.Cut(link, "?")
			if !tabbed[path] {
				continue
			}
			checked++
			if !strings.Contains(query, "tab=") {
				t.Errorf("%s: Link %q opens a tabbed page without naming a tab, so the reader lands on whatever that page defaults to", f, link)
			}
		}
	}
	// A guard on the guard: if the links move or are renamed, this test must
	// fail loudly rather than quietly checking nothing.
	if checked < 8 {
		t.Fatalf("only %d tabbed notification links found; the assertion above is no longer covering them", checked)
	}
}
