package action

// The agent's copy of the catalog (v0.26). It is compiled in, so a plan can
// only ever name something this file implements: there is no command, script,
// path or URL parameter anywhere, and no way to add one without shipping a new
// signed agent build through the offline-rooted update chain.
//
// Keep in step with apps/api/src/actions/catalog.ts; the portal and signer
// copy decides what can be proposed, this copy decides what can run.

// ServiceName is the only service any action in this release touches.
const ServiceName = "Spooler"

// MinApprovals by risk; the same numbers as APPROVALS_REQUIRED in the portal.
var MinApprovals = map[string]int{"low": 1, "high": 2}

type Action struct {
	ID       string
	Version  int
	ParamsOK func(map[string]any) bool
	// Risk from this machine's own product type: anything but a workstation
	// is high impact, whatever the plan claims.
	Risk func(productType int) string
}

var catalog = []Action{
	{
		ID: "windows.service.start", Version: 1,
		ParamsOK: func(p map[string]any) bool {
			if len(p) != 1 {
				return false
			}
			s, ok := p["service"].(string)
			return ok && s == ServiceName
		},
		Risk: func(pt int) string {
			if pt == 1 {
				return "low"
			}
			return "high"
		},
	},
}

func Lookup(id string, version int) *Action {
	for i := range catalog {
		if catalog[i].ID == id && catalog[i].Version == version {
			return &catalog[i]
		}
	}
	return nil
}

// Supported is what the heartbeat reports, as "id@version".
func Supported() []string {
	out := make([]string, 0, len(catalog))
	for _, a := range catalog {
		out = append(out, a.ID+"@"+itoa(a.Version))
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
