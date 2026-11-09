package agent

import (
	"net/url"
	"strings"
)

// ParseSlotURL reads the portal address and claim token out of the URL the
// portal patches into the bootstrap's slot:
//
//	https://<portal>/api/v1/public/install/windows.ps1?token=<hex>
//
// The same slot format older portals write, so a signed bootstrap served by an
// unmodified portal still works. Only the host and token are taken; the path is
// fixed by the agent, so the slot can no longer choose what code is fetched.
func ParseSlotURL(raw string) (portal, token string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.User != nil || !ValidPortal(u.Host) {
		return "", "", false
	}
	if !strings.HasSuffix(u.Path, "/public/install/windows.ps1") {
		return "", "", false
	}
	token = u.Query().Get("token")
	if token != "" && !tokenRE.MatchString(token) {
		return "", "", false
	}
	return u.Host, token, true
}
