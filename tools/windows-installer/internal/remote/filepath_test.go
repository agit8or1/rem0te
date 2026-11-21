package remote

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The shared fixture: the portal's unit-files.mjs asserts the same file.
func TestCheckPathFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/file-paths.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Path string `json:"path"`
			OK   bool   `json:"ok"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 40 {
		t.Fatalf("only %d cases", len(fx.Cases))
	}
	for _, c := range fx.Cases {
		got := CheckPath(c.Path)
		if (got == "") != c.OK {
			t.Errorf("CheckPath(%q) = %q, want ok=%v", c.Path, got, c.OK)
		}
	}
}

func TestCheckPathLength(t *testing.T) {
	long := `C:\` + strings.Repeat("a", FilePathMax-3)
	if CheckPath(long) != "" {
		t.Error("1,024 characters should pass")
	}
	if CheckPath(long+"a") == "" {
		t.Error("1,025 characters should be refused")
	}
}
