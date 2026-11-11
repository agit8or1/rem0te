package patch

import (
	"crypto/ed25519"
	"fmt"
	"strings"

	"github.com/agit8or1/rem0te/windows-installer/internal/devsig"
)

// ScanStatement (v0.34) is what this computer signs about one scan: the
// facts the ring gate reads, and nothing it does not — no titles, sizes or
// managers. "effective" is still the portal's and the signer's to derive.
func ScanStatement(p Posture, rustdeskID, secretSHA256 string) devsig.ScanStatement {
	st := devsig.ScanStatement{
		Schema: devsig.ScanStatementSchema, RustdeskID: rustdeskID, DeviceSecretSHA256: strings.ToLower(secretSHA256),
		ScannedAt: p.ScannedAt, Error: p.Error != "", RebootPending: p.Reboot.Pending,
		Offered: []string{}, Installed: []string{},
	}
	for _, u := range p.Updates {
		st.Offered = append(st.Offered, fmt.Sprintf("%s@%d", u.UpdateID, u.Revision))
	}
	seen := map[string]bool{}
	for _, h := range p.History {
		k := fmt.Sprintf("%s@%d", h.UpdateID, h.Revision)
		if h.Operation == "install" && h.Result == "succeeded" && !seen[k] {
			seen[k] = true
			st.Installed = append(st.Installed, k)
		}
	}
	return st
}

// SignScan sets p.Signed with this computer's key.
func SignScan(p *Posture, k ed25519.PrivateKey, rustdeskID, secretSHA256 string) error {
	p.Signed = nil
	s, err := devsig.Sign(k, devsig.ScanPrefix, ScanStatement(*p, rustdeskID, secretSHA256))
	if err != nil {
		return err
	}
	p.Signed = s
	return nil
}
