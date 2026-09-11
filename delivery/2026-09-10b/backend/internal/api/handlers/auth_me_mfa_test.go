package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// /auth/me has to say whether the account HOLDS a second factor, not only
// whether policy demands one.
//
// It did not, and the console had no other way to find out: the device table
// is not readable from a browser. So an account under an MFA rule was told to
// set up a second factor on every page it opened, for ever, including accounts
// that had enrolled minutes earlier. The value was already being computed on
// every one of these requests to decide mfa_enrolment_required; it was simply
// dropped before the response was written.
func TestMeReportsWhetherTheAccountHoldsASecondFactor(t *testing.T) {
	for _, tc := range []struct {
		name     string
		posture  MFAPosture
		wantMFA  bool
		wantReq  bool
		wantMode string
	}{
		{
			name:     "under policy and enrolled",
			posture:  MFAPosture{Required: true, Mode: "enforce", EnrolmentRequired: false, Enrolled: true},
			wantMFA:  true,
			wantReq:  true,
			wantMode: "enforce",
		},
		{
			name:     "under policy and not enrolled",
			posture:  MFAPosture{Required: true, Mode: "enforce", EnrolmentRequired: true, Enrolled: false},
			wantMFA:  false,
			wantReq:  true,
			wantMode: "enforce",
		},
		{
			// No rule gates this account, but it enrolled anyway. The console
			// shows enrolment state on the profile menu and the security tab
			// regardless of policy, so the field cannot be conditional on it.
			name:     "no policy, enrolled anyway",
			posture:  MFAPosture{Required: false, Mode: "off", EnrolmentRequired: false, Enrolled: true},
			wantMFA:  true,
			wantReq:  false,
			wantMode: "off",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			h := NewAuthHandler(nil, func(string, []string) (MFAPosture, error) {
				return tc.posture, nil
			}, zap.NewNop())

			r := gin.New()
			if err := r.SetTrustedProxies(nil); err != nil {
				t.Fatal(err)
			}
			r.Use(func(c *gin.Context) {
				c.Set("user_id", "u-1")
				c.Set("username", "s.mehta")
				c.Set("roles", []string{"user"})
				c.Next()
			})
			r.GET("/api/v1/auth/me", h.Me)

			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil))
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", w.Code, w.Body.String())
			}

			var env struct {
				Data map[string]any `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
				t.Fatalf("decode: %v (%s)", err, w.Body.String())
			}
			got, present := env.Data["mfa_enabled"]
			if !present {
				t.Fatalf("mfa_enabled is missing; the console cannot tell an enrolled account from one that has to enrol: %v", env.Data)
			}
			if got != tc.wantMFA {
				t.Errorf("mfa_enabled = %v, want %v", got, tc.wantMFA)
			}
			if env.Data["mfa_required"] != tc.wantReq {
				t.Errorf("mfa_required = %v, want %v", env.Data["mfa_required"], tc.wantReq)
			}
			if env.Data["mfa_policy_mode"] != tc.wantMode {
				t.Errorf("mfa_policy_mode = %v, want %v", env.Data["mfa_policy_mode"], tc.wantMode)
			}
		})
	}
}

// A policy lookup that fails must not take the whole identity call with it,
// and it must not leave a half-filled posture behind either: the console reads
// an absent block as "not reported" and stops making claims, which is the only
// honest thing to do when the server could not answer.
func TestMeDropsTheWholePostureWhenItCannotBeResolved(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := NewAuthHandler(nil, func(string, []string) (MFAPosture, error) {
		return MFAPosture{}, errNotResolvable
	}, zap.NewNop())

	r := gin.New()
	if err := r.SetTrustedProxies(nil); err != nil {
		t.Fatal(err)
	}
	r.Use(func(c *gin.Context) {
		c.Set("user_id", "u-1")
		c.Set("username", "s.mehta")
		c.Set("roles", []string{"user"})
		c.Next()
	})
	r.GET("/api/v1/auth/me", h.Me)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, k := range []string{"mfa_enabled", "mfa_required", "mfa_policy_mode", "mfa_enrolment_required"} {
		if _, present := env.Data[k]; present {
			t.Errorf("%s was reported from a posture that could not be resolved", k)
		}
	}
}

type notResolvable struct{}

func (notResolvable) Error() string { return "policy table unreadable" }

var errNotResolvable = notResolvable{}
