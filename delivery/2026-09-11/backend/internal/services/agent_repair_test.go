package services

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
)

// freshDeviceKey stands in for what `pam-agent install` does on the operator's
// machine: it generates a BRAND NEW keypair every single time (see the agent's
// keystore.Generate). That is the reason the server cannot recognise a
// returning machine by its public key, and the reason this test hands a
// different key to every pairing below.
const pairingTTLForTest = 10 * time.Minute

func freshDeviceKey(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return base64.StdEncoding.EncodeToString(pub)
}

// pairOnce issues a code and redeems it, which is exactly what one run of the
// installer does.
func pairOnce(t *testing.T, svc *AgentService, userID, deviceName string) *models.AgentDevice {
	t.Helper()
	code, _, err := svc.InitPairing(userID, pairingTTLForTest)
	if err != nil {
		t.Fatalf("InitPairing: %v", err)
	}
	device, err := svc.CompletePairing(code, deviceName, freshDeviceKey(t))
	if err != nil {
		t.Fatalf("CompletePairing: %v", err)
	}
	return device
}

// Re-running the installer on a machine that is already paired UPDATES that
// machine's row. It does not add another one.
//
// Reproduced from a real deployment's agent log: twenty-six pairings of one
// laptop, every one logging a different agent_device_id, all named
// "DESKTOP-ETQ5PKL (windows)". The Devices list in Settings grew by a row each
// time, and every stale row was still a live credential the operator could not
// tell apart from their current machine.
func TestRePairingTheSameMachineUpdatesItsRowInsteadOfAddingOne(t *testing.T) {
	db := newLaunchTestDB(t)
	svc := NewAgentService(db, nil, nil, nil, zap.NewNop())
	const user = "u-pranav"
	const machine = "DESKTOP-ETQ5PKL (windows)"

	first := pairOnce(t, svc, user, machine)

	// Ten re-installs, the way a week of testing produces them.
	for i := 0; i < 10; i++ {
		again := pairOnce(t, svc, user, machine)
		if again.ID != first.ID {
			t.Fatalf("re-pair %d created a new device row (%s) instead of updating %s", i+1, again.ID, first.ID)
		}
	}

	devices, err := svc.ListDevices(user)
	if err != nil {
		t.Fatalf("ListDevices: %v", err)
	}
	if len(devices) != 1 {
		names := make([]string, 0, len(devices))
		for _, d := range devices {
			names = append(names, d.ID+"/"+d.DeviceName)
		}
		t.Fatalf("Settings would list %d devices for one machine: %v", len(devices), names)
	}
	// The row has to carry the LATEST pairing, or the operator is looking at a
	// device that says it was last seen a week ago while they are using it.
	if devices[0].LastSeenAt == nil {
		t.Error("last_seen_at was not refreshed by the re-pair, so the list shows a stale time")
	}
	if devices[0].Status != "ACTIVE" {
		t.Errorf("status = %q, want ACTIVE", devices[0].Status)
	}
}

// The newest keypair is the one that can authenticate: the installer
// overwrote the keystore, so the previous private key no longer exists
// anywhere. Keeping the old public key would leave a credential on the row
// that can never be used again while looking like it could.
func TestRePairingReplacesTheStoredPublicKey(t *testing.T) {
	db := newLaunchTestDB(t)
	svc := NewAgentService(db, nil, nil, nil, zap.NewNop())
	const user = "u-pranav"
	const machine = "DESKTOP-ETQ5PKL (windows)"

	first := pairOnce(t, svc, user, machine)
	firstKey := first.PublicKey

	second := pairOnce(t, svc, user, machine)
	if second.PublicKey == firstKey {
		t.Fatal("the row still carries the old public key, which no longer has a private half")
	}

	var stored models.AgentDevice
	if err := db.Where("id = ?", first.ID).First(&stored).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if stored.PublicKey != second.PublicKey {
		t.Errorf("stored key = %q, want the key from the latest pairing", stored.PublicKey)
	}
}

// Two genuinely different machines stay two rows. The fix must not collapse
// the operator's laptop and their workstation into one entry.
func TestDifferentMachinesStayDifferentDevices(t *testing.T) {
	db := newLaunchTestDB(t)
	svc := NewAgentService(db, nil, nil, nil, zap.NewNop())
	const user = "u-pranav"

	laptop := pairOnce(t, svc, user, "DESKTOP-ETQ5PKL (windows)")
	workstation := pairOnce(t, svc, user, "MACBOOK-PRANAV (darwin)")
	if laptop.ID == workstation.ID {
		t.Fatal("two different machines were collapsed into one device row")
	}

	devices, err := svc.ListDevices(user)
	if err != nil {
		t.Fatalf("ListDevices: %v", err)
	}
	if len(devices) != 2 {
		t.Fatalf("got %d devices, want 2", len(devices))
	}
}

// The same machine name under two different accounts is two devices. Reusing
// a row across users would hand one person's agent credential to another.
func TestTheSameMachineNameUnderTwoAccountsIsTwoDevices(t *testing.T) {
	db := newLaunchTestDB(t)
	svc := NewAgentService(db, nil, nil, nil, zap.NewNop())
	const machine = "DESKTOP-ETQ5PKL (windows)"

	mine := pairOnce(t, svc, "u-pranav", machine)
	theirs := pairOnce(t, svc, "u-someone-else", machine)
	if mine.ID == theirs.ID {
		t.Fatal("one user's device row was handed to another user")
	}
}

// A device an administrator REVOKED is never silently brought back to life.
// Re-pairing after a revocation gets a new row, and the revoked one stays as
// the record of the decision.
func TestARevokedDeviceIsNotResurrectedByRePairing(t *testing.T) {
	db := newLaunchTestDB(t)
	svc := NewAgentService(db, nil, nil, nil, zap.NewNop())
	const user = "u-pranav"
	const machine = "DESKTOP-ETQ5PKL (windows)"

	original := pairOnce(t, svc, user, machine)
	if err := db.Model(&models.AgentDevice{}).Where("id = ?", original.ID).
		Update("status", "REVOKED").Error; err != nil {
		t.Fatalf("revoke: %v", err)
	}

	after := pairOnce(t, svc, user, machine)
	if after.ID == original.ID {
		t.Fatal("re-pairing reactivated a device an administrator had revoked")
	}

	var revoked models.AgentDevice
	if err := db.Where("id = ?", original.ID).First(&revoked).Error; err != nil {
		t.Fatalf("the revoked row was deleted rather than kept as a record: %v", err)
	}
	if revoked.Status != "REVOKED" {
		t.Errorf("the revoked row's status became %q", revoked.Status)
	}
}
