package handlers

import (
	"encoding/json"
	"testing"
	"time"
)

// The console decides whether to show the "enrol a second factor" banner from
// one field on /auth/me. It used to be absent: the posture carried the
// requirement but never whether the account already met it, so the reader fell
// back to a guess kept in the browser's local storage, and an account that had
// been enrolled for months was told to enrol again from any fresh browser.
//
// These names are a contract with src/lib/mfaPolicy.js and src/lib/mfaStatus.js.
// Renaming a key here silently brings the banner back.
func TestMFAPostureCarriesEnrolment(t *testing.T) {
	at := time.Date(2026, 3, 3, 9, 30, 0, 0, time.UTC)
	raw, err := json.Marshal(MFAPosture{
		Required:   true,
		Mode:       "monitor",
		Enrolled:   true,
		EnrolledAt: &at,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if v, ok := got["mfa_enabled"].(bool); !ok || !v {
		t.Errorf("mfa_enabled: got %#v, want true", got["mfa_enabled"])
	}
	if _, ok := got["mfa_enabled_at"]; !ok {
		t.Error("mfa_enabled_at is missing for an enrolled account")
	}
	for _, k := range []string{"mfa_required", "mfa_policy_mode", "mfa_enrolment_required"} {
		if _, ok := got[k]; !ok {
			t.Errorf("%s is missing", k)
		}
	}
}

// An account with no factor must still say so explicitly rather than leaving
// the key off, because an absent key and a false one read the same to the
// console only by accident, and the whole bug was an absent key.
func TestMFAPostureSaysNotEnrolledExplicitly(t *testing.T) {
	raw, err := json.Marshal(MFAPosture{Required: true, Mode: "enforce", EnrolmentRequired: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	v, ok := got["mfa_enabled"].(bool)
	if !ok {
		t.Fatalf("mfa_enabled: got %#v, want a bool", got["mfa_enabled"])
	}
	if v {
		t.Error("mfa_enabled is true for an account with no factor")
	}
	if _, ok := got["mfa_enabled_at"]; ok {
		t.Error("mfa_enabled_at should be omitted when nothing is enrolled")
	}
}
