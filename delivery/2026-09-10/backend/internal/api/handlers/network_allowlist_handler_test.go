package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	glogger "gorm.io/gorm/logger"

	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/services"
)

// Wires the real router, the real root gate, the real handler and a real
// database, then drives it over HTTP — so the thing under test is the same
// path a browser takes, not a hand-called function.
func newAllowlistAPI(t *testing.T, roles []string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	dsn := "file:" + t.Name() + "?mode=memory&cache=shared&_pragma=busy_timeout(5000)"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{Logger: glogger.Discard})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&models.NetworkAllowlistEntry{}, &models.NetworkAllowlistSettings{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	h := NewNetworkAllowlistHandler(services.NewNetworkAllowlistService(db, config.TrustedProxyDirect))

	r := gin.New()
	if err := r.SetTrustedProxies(nil); err != nil {
		t.Fatal(err)
	}
	// Stand in for PAMAuth, which is what puts the roles claim in context.
	r.Use(func(c *gin.Context) {
		c.Set("roles", roles)
		c.Set("user_id", "u-root")
		c.Set("username", "root")
		c.Next()
	})
	g := r.Group("/api/v1/pam/admin/network", middleware.RequireRoot())
	{
		g.GET("/allowlist", h.Get)
		g.POST("/allowlist", h.Add)
		g.DELETE("/allowlist/:id", h.Remove)
		g.PUT("/allowlist/enabled", h.SetEnabled)
	}
	return r
}

func call(t *testing.T, r *gin.Engine, method, path, from string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = bytes.NewReader(raw)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.RemoteAddr = from + ":40000"
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// An admin is not enough. This is the control that decides who can reach the
// product, so an admin able to edit it could lock root out.
func TestOnlyRootMayTouchTheAllowlist(t *testing.T) {
	for _, roles := range [][]string{{"admin"}, {"user"}, {}, nil} {
		r := newAllowlistAPI(t, roles)
		if w := call(t, r, http.MethodGet, "/api/v1/pam/admin/network/allowlist", "203.0.113.9", nil); w.Code != http.StatusForbidden {
			t.Errorf("roles %v got %d on GET, want 403", roles, w.Code)
		}
		if w := call(t, r, http.MethodPost, "/api/v1/pam/admin/network/allowlist", "203.0.113.9",
			map[string]string{"cidr": "10.0.0.0/8"}); w.Code != http.StatusForbidden {
			t.Errorf("roles %v got %d on POST, want 403", roles, w.Code)
		}
	}
}

// The whole lifecycle over HTTP, from an empty list to enforcement on.
func TestAllowlistLifecycleOverHTTP(t *testing.T) {
	r := newAllowlistAPI(t, []string{"root"})
	const me = "183.82.2.29"

	// Starts empty and open, and tells the operator the address the API sees.
	w := call(t, r, http.MethodGet, "/api/v1/pam/admin/network/allowlist", me, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d: %s", w.Code, w.Body.String())
	}
	var got struct {
		Data struct {
			Enabled bool `json:"enabled"`
			Entries []struct {
				ID   string `json:"id"`
				CIDR string `json:"cidr"`
			} `json:"entries"`
			YourIP string `json:"your_ip"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v — %s", err, w.Body.String())
	}
	if got.Data.Enabled || len(got.Data.Entries) != 0 {
		t.Fatalf("a fresh deployment should start empty and off: %+v", got.Data)
	}
	if got.Data.YourIP != me {
		t.Errorf("your_ip = %q, want the address the API saw (%s)", got.Data.YourIP, me)
	}

	// Turning it on with nothing listed is refused, not obeyed.
	if w := call(t, r, http.MethodPut, "/api/v1/pam/admin/network/allowlist/enabled", me,
		map[string]bool{"enabled": true}); w.Code != http.StatusConflict {
		t.Fatalf("enabling an empty allowlist = %d, want 409: %s", w.Code, w.Body.String())
	}

	// Add a range that does NOT cover the caller, and it is still refused.
	if w := call(t, r, http.MethodPost, "/api/v1/pam/admin/network/allowlist", me,
		map[string]string{"cidr": "10.0.0.0/8", "label": "vpn"}); w.Code != http.StatusCreated {
		t.Fatalf("POST = %d: %s", w.Code, w.Body.String())
	}
	if w := call(t, r, http.MethodPut, "/api/v1/pam/admin/network/allowlist/enabled", me,
		map[string]bool{"enabled": true}); w.Code != http.StatusConflict {
		t.Fatalf("enabling from outside every range = %d, want 409", w.Code)
	}

	// Add the caller's own range, and now it goes through.
	if w := call(t, r, http.MethodPost, "/api/v1/pam/admin/network/allowlist", me,
		map[string]string{"cidr": me, "label": "head office"}); w.Code != http.StatusCreated {
		t.Fatalf("POST own IP = %d: %s", w.Code, w.Body.String())
	}
	if w := call(t, r, http.MethodPut, "/api/v1/pam/admin/network/allowlist/enabled", me,
		map[string]bool{"enabled": true}); w.Code != http.StatusOK {
		t.Fatalf("enabling from a listed address = %d: %s", w.Code, w.Body.String())
	}

	// Read it back: enabled, two entries, the operator's own stored as /32.
	w = call(t, r, http.MethodGet, "/api/v1/pam/admin/network/allowlist", me, nil)
	got.Data.Entries = nil
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Data.Enabled || len(got.Data.Entries) != 2 {
		t.Fatalf("after enabling: %+v", got.Data)
	}
	var mine string
	for _, e := range got.Data.Entries {
		if e.CIDR == me+"/32" {
			mine = e.ID
		}
	}
	if mine == "" {
		t.Fatalf("a bare address should be stored as /32, got %+v", got.Data.Entries)
	}

	// Removing the ground the operator stands on is refused.
	if w := call(t, r, http.MethodDelete, "/api/v1/pam/admin/network/allowlist/"+mine, me, nil); w.Code != http.StatusConflict {
		t.Fatalf("removing own range = %d, want 409: %s", w.Code, w.Body.String())
	}

	// Turning it off is never refused, even from an address off the list.
	if w := call(t, r, http.MethodPut, "/api/v1/pam/admin/network/allowlist/enabled", "203.0.113.9",
		map[string]bool{"enabled": false}); w.Code != http.StatusOK {
		t.Fatalf("disabling from outside = %d, want 200: %s", w.Code, w.Body.String())
	}
	// ...and then the removal is allowed.
	if w := call(t, r, http.MethodDelete, "/api/v1/pam/admin/network/allowlist/"+mine, "203.0.113.9", nil); w.Code != http.StatusOK {
		t.Fatalf("removing with enforcement off = %d: %s", w.Code, w.Body.String())
	}
}

// A missing "enabled" field must not read as "turn it off".
func TestSetEnabledRequiresAnExplicitValue(t *testing.T) {
	r := newAllowlistAPI(t, []string{"root"})
	w := call(t, r, http.MethodPut, "/api/v1/pam/admin/network/allowlist/enabled", "10.0.0.1",
		map[string]string{"something": "else"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("a body with no enabled field = %d, want 400: %s", w.Code, w.Body.String())
	}
}

func TestAddRejectsNonsense(t *testing.T) {
	r := newAllowlistAPI(t, []string{"root"})
	for _, bad := range []string{"", "not-an-ip", "10.0.0.0/33"} {
		w := call(t, r, http.MethodPost, "/api/v1/pam/admin/network/allowlist", "10.0.0.1",
			map[string]string{"cidr": bad})
		if w.Code != http.StatusBadRequest {
			t.Errorf("cidr %q = %d, want 400: %s", bad, w.Code, w.Body.String())
		}
		if bad != "" && !strings.Contains(w.Body.String(), "valid") {
			t.Errorf("cidr %q: the message should say what is wrong: %s", bad, w.Body.String())
		}
	}
}
