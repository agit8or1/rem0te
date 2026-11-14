package action

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// headFake answers FileHead for the shared fixture: an NSIS header for the
// files marked nsis. It never runs anything.
type headFake struct{ nsis map[string]bool }

func (h headFake) Program(string, string) (Program, bool, error) { return Program{}, false, nil }
func (h headFake) Remove(RemovalCommand, time.Duration) (int, []byte, error) {
	panic("the decision must not run anything")
}
func (h headFake) FileHead(path string, max int) ([]byte, error) {
	if h.nsis[path] {
		return []byte("MZ stub " + NSISMarker + " first header"), nil
	}
	return []byte("MZ stub"), nil
}

// TestRemovalKindsFixture runs the agent's decision over the fixture the
// inventory collector is tested against too (apps/api/scripts/unit-software.mjs,
// under pwsh), so the console offers Uninstall exactly where the agent acts
// (0.42).
func TestRemovalKindsFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("testdata", "removal-kinds.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Name, Key, DisplayName, UninstallString, QuietUninstallString, Kind string
			WindowsInstaller, NSIS                                              bool
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &fx); err != nil || len(fx.Cases) < 25 {
		t.Fatalf("fixture: %v (%d cases)", err, len(fx.Cases))
	}
	for _, c := range fx.Cases {
		h := headFake{nsis: map[string]bool{}}
		if c.NSIS {
			if pc, err := ParseQuietUninstall(c.UninstallString); err == nil {
				h.nsis[pc.Exe] = true
			}
		}
		pr := Program{DisplayName: c.DisplayName, UninstallString: c.UninstallString, QuietUninstallString: c.QuietUninstallString, WindowsInstaller: c.WindowsInstaller}
		got := "none"
		cmd, r := removalFor(c.Key, pr, Options{Programs: h})
		switch {
		case r == nil:
			got = cmd.Kind
		case strings.Contains(r.Detail, "Click-to-Run"):
			got = "office"
		case strings.Contains(r.Detail, "driver package"):
			got = "driver"
		}
		if got != c.Kind {
			t.Errorf("%s: kind %q, want %q (%+v %+v)", c.Name, got, c.Kind, cmd, r)
		}
	}
}
