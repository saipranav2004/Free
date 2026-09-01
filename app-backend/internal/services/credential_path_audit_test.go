package services

import (
	"strings"
	"testing"

	"github.com/yourorg/pam/pkg/crypto"
)

// THE FORMAT SEAM THAT USED TO SPLIT THIS PRODUCT IN TWO.
//
// Credentials attached from the Resources screen were sealed with one AES-GCM
// layer under the master key; credentials attached from the Vault screen were
// sealed as an envelope, bound to their row by AAD. Both wrote the same table,
// and the connection path read every row with the single-layer reader, which
// cannot parse an envelope. A credential attached to a resource through the
// Vault screen therefore could not be used to connect to it.
//
// Both paths now go through the vault, so nothing new is written in the old
// format. This test keeps the two facts that matter: the single-layer reader
// genuinely cannot read an envelope (so the seam was real, and reintroducing a
// direct crypto.Decrypt on a credential would break connections again), and
// the vault reader still reads rows written before the change, which is why no
// migration was needed.
func TestCredentialFormatsAndTheLegacyReadPath(t *testing.T) {
	const key = "MRj5waDrH+pH1/lruVNZYtXp+wzzb7YNbMnB6NLN2N8="

	// What the vault path writes.
	kms, err := crypto.NewLocalKMSProvider(key)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := crypto.EnvelopeEncryptor(t.Context(), kms, "VaultStored-Secret-99",
		map[string]string{"account": "minioadmin", "safe_id": "default"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(envelope, "{") {
		t.Fatalf("expected an envelope JSON, got %.20q", envelope)
	}

	// What the connection path does with it.
	if _, err := crypto.Decrypt(envelope, key); err == nil {
		t.Fatal("expected the single-layer reader to fail on an envelope; if this now passes, the paths have been unified and this test should be replaced")
	}

	// And the reverse direction, which does work, because EnvelopeDecryptor
	// keeps a legacy branch for exactly this.
	legacy, err := crypto.Encrypt("ResourceStored-Secret-01", key)
	if err != nil {
		t.Fatal(err)
	}
	got, err := crypto.EnvelopeDecryptor(t.Context(), kms, legacy, nil)
	if err != nil {
		t.Fatalf("vault reader should still read a legacy row: %v", err)
	}
	if got != "ResourceStored-Secret-01" {
		t.Fatalf("got %q", got)
	}
}
