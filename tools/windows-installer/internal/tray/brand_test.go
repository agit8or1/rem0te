package tray

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestBrandFile(t *testing.T) {
	b := Brand{Business: "MSP Reboot", Provider: "Agit8or.net", SupportText: "Support: 555-0100 · help@example.com", Accent: "#112233"}
	got, ok := ParseBrand(MarshalBrand(b))
	if !ok || got != b {
		t.Fatalf("round trip: %+v %v", got, ok)
	}
	// A BOM is fine; the file is re-cleaned on read.
	got, ok = ParseBrand([]byte("\xef\xbb\xbf" + `{"business":"  A\u0007cme \n Inc ","provider":"` + strings.Repeat("p", 100) + `","supportText":"x","accent":"red"}`))
	if !ok || got.Business != "A cme Inc" || len(got.Provider) != 64 || got.Accent != "" {
		t.Errorf("not re-cleaned: %+v %v", got, ok)
	}
	// Anything but the four fields is treated as no file.
	for _, bad := range []string{
		"", "not json", "[]", `{"business":"A"} {"business":"B"}`,
		`{"business":"A","trayKey":"tk_x"}`,
		`{"business":"A","conversationId":"clx0000000000000000000001"}`,
		`{"business":"A","text":"a message"}`,
		`{"business":"A","portal":"evil.example"}`,
		`{"business":"` + strings.Repeat("a", MaxBrandFileBytes) + `"}`,
	} {
		if _, ok := ParseBrand([]byte(bad)); ok {
			t.Errorf("accepted %.60q", bad)
		}
	}
	// The written file holds the four fields and nothing else.
	var m map[string]any
	if err := json.Unmarshal(MarshalBrand(b), &m); err != nil || len(m) != 4 {
		t.Errorf("brand file %s: %v", MarshalBrand(b), err)
	}
	for _, k := range []string{"business", "provider", "supportText", "accent"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
}

func TestWithBrand(t *testing.T) {
	cached := Brand{Business: "MSP Reboot", Provider: "Agit8or.net", SupportText: "Call", Accent: "#112233"}
	s := WithBrand(State{Offline: true}, cached)
	if s.Business != "MSP Reboot" || s.Provider != "Agit8or.net" || s.SupportText != "Call" || s.Accent != "#112233" || !s.Offline {
		t.Errorf("empty state not filled: %+v", s)
	}
	// What the portal named wins, even if it is only one field.
	s = WithBrand(State{Business: "Birch"}, cached)
	if s.Business != "Birch" || s.Provider != "" {
		t.Errorf("portal's brand overwritten: %+v", s)
	}
	if ProviderOr("") != "your IT provider" || ProviderTitle(" ") != "Your IT provider" || ProviderOr("Agit8or.net") != "Agit8or.net" {
		t.Error("provider fallback")
	}
}

func TestToolsNameTheProvider(t *testing.T) {
	r := &Runner{OS: &fakeOS{}, Portal: "portal.example.com"}
	res := r.RunFor(context.Background(), "net.test", "Agit8or.net")
	if res.Summary != "This computer can reach Agit8or.net." || !strings.Contains(strings.Join(res.Lines, "\n"), "Agit8or.net's portal (portal.example.com): connected securely") {
		t.Errorf("%+v", res)
	}
	if res = r.Run(context.Background(), "net.test"); res.Summary != "This computer can reach your IT provider." {
		t.Errorf("generic: %+v", res)
	}
	// The host names the provider the portal last named for that user.
	c, _, _ := newCore(t, deviceCred, true)
	if _, _, err := c.Refresh(context.Background(), `PC\bob`, false); err != nil {
		t.Fatal(err)
	}
	if res = c.SelfHelp(context.Background(), `PC\bob`, "net.test"); res.Summary != "This computer can reach Prov." {
		t.Errorf("core: %+v", res)
	}
	if res = c.SelfHelp(context.Background(), `PC\alice`, "net.test"); res.Summary != "This computer can reach your IT provider." {
		t.Errorf("another user, no state yet: %+v", res)
	}
}
