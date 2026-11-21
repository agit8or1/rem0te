package action

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 0.79 (§89): every catalog action declares its rollback and whether it is
// safe to repeat, and the agent's copy agrees with the portal's through the
// shared fixture (the portal's unit-action-rollback.mjs reads the same file).

type rollbackFixture struct {
	RollbackKinds []string `json:"rollbackKinds"`
	Actions       []struct {
		ID         string `json:"id"`
		Version    int    `json:"version"`
		Rollback   string `json:"rollback"`
		Via        string `json:"via"`
		Repeatable bool   `json:"repeatable"`
	} `json:"actions"`
}

func loadRollbackFixture(t *testing.T) rollbackFixture {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "rollback-repeat.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f rollbackFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestRollbackKindsAreTheFixturesInOrder(t *testing.T) {
	f := loadRollbackFixture(t)
	if len(f.RollbackKinds) != len(RollbackKinds) {
		t.Fatalf("kinds: fixture %v, agent %v", f.RollbackKinds, RollbackKinds)
	}
	for i := range RollbackKinds {
		if f.RollbackKinds[i] != RollbackKinds[i] {
			t.Fatalf("kinds: fixture %v, agent %v", f.RollbackKinds, RollbackKinds)
		}
	}
}

func TestEveryActionDeclaresRollbackAndRepeat(t *testing.T) {
	known := map[string]bool{}
	for _, k := range RollbackKinds {
		known[k] = true
	}
	for _, a := range catalog {
		if !known[a.Rollback.Kind] {
			t.Errorf("%s: rollback kind %q is not one of %v", a.ID, a.Rollback.Kind, RollbackKinds)
		}
		switch a.Rollback.Kind {
		case RollbackInverse:
			if Lookup(a.Rollback.Via, 1) == nil {
				t.Errorf("%s: rolled back by %q, which is not in the catalog", a.ID, a.Rollback.Via)
			}
		default:
			if a.Rollback.Via != "" {
				t.Errorf("%s: a %s rollback names no action, got %q", a.ID, a.Rollback.Kind, a.Rollback.Via)
			}
		}
		// Read-only is always safe to repeat: it changes nothing.
		if a.Rollback.Kind == RollbackReadOnly && !a.Repeatable {
			t.Errorf("%s: read-only but not repeatable", a.ID)
		}
	}
}

func TestCatalogMatchesTheSharedFixture(t *testing.T) {
	f := loadRollbackFixture(t)
	if len(f.Actions) != len(catalog) {
		t.Fatalf("fixture has %d actions, catalog %d", len(f.Actions), len(catalog))
	}
	for i, want := range f.Actions {
		got := catalog[i]
		if got.ID != want.ID || got.Version != want.Version {
			t.Fatalf("position %d: catalog %s@%d, fixture %s@%d", i, got.ID, got.Version, want.ID, want.Version)
		}
		if got.Rollback.Kind != want.Rollback || got.Rollback.Via != want.Via || got.Repeatable != want.Repeatable {
			t.Errorf("%s: catalog {%s %q %v}, fixture {%s %q %v}", got.ID, got.Rollback.Kind, got.Rollback.Via, got.Repeatable, want.Rollback, want.Via, want.Repeatable)
		}
	}
}

// The two actions that are not safe to repeat are exactly the ones whose
// second run does something the first did not: a second restart, and a
// script whose effect the catalog cannot know.
func TestOnlyRestartAndScriptAreNotRepeatable(t *testing.T) {
	var not []string
	for _, a := range catalog {
		if !a.Repeatable {
			not = append(not, a.ID)
		}
	}
	if len(not) != 2 || not[0] != "windows.reboot.schedule" || not[1] != "windows.script.run" {
		t.Fatalf("not repeatable: %v", not)
	}
}
