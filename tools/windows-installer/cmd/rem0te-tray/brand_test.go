package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

func u16len(s string) int { return len(utf16.Encode([]rune(s))) }

func TestMenuHeader(t *testing.T) {
	full := tray.State{Business: "MSP Reboot", Provider: "Agit8or.net", SupportText: "Support: 555-0100 · help@example.com"}
	h := menuHeader(full)
	if len(h) != 2 || h[0] != "MSP Reboot · supported by Agit8or.net" || h[1] != "Support: 555-0100 · help@example.com" {
		t.Errorf("full header %q", h)
	}
	for _, c := range []struct {
		s    tray.State
		want []string
	}{
		{tray.State{Business: "MSP Reboot"}, []string{"MSP Reboot"}},
		{tray.State{Provider: "Agit8or.net"}, []string{"Supported by Agit8or.net"}},
		{tray.State{SupportText: "Call 555"}, []string{"Call 555"}},
		{tray.State{}, nil},
		// "&" is a menu mnemonic: doubled so it shows as itself.
		{tray.State{Business: "A&B Plumbing", Provider: "P&Q"}, []string{"A&&B Plumbing · supported by P&&Q"}},
	} {
		if got := menuHeader(c.s); strings.Join(got, "|") != strings.Join(c.want, "|") {
			t.Errorf("%+v: %q, want %q", c.s, got, c.want)
		}
	}
	long := menuHeader(tray.State{Business: strings.Repeat("B", 64), Provider: strings.Repeat("P", 64)})
	if len(long) != 1 || u16len(long[0]) > maxMenuText || !strings.HasSuffix(long[0], "…") {
		t.Errorf("long header %q", long)
	}
}

func TestBrandedPhrases(t *testing.T) {
	s := tray.State{Business: "MSP Reboot", Provider: "Agit8or.net", RecordNew: true, Offline: true}
	if menuLabel(s) != "Chat with Agit8or.net" {
		t.Error(menuLabel(s))
	}
	if toolLabel(tray.ToolState{Title: "Flush DNS", Blocked: "x"}, s.Provider) != "Flush DNS (paused by Agit8or.net)" {
		t.Error("tool label")
	}
	a := aboutText(s)
	if !strings.Contains(a, "Agit8or.net keeps a transcript") || !strings.Contains(a, "Agit8or.net's portal cannot be reached") || strings.Contains(a, "IT provider") {
		t.Errorf("about %q", a)
	}
	ti, tx := newMessageBalloon(s)
	if ti != "New message from Agit8or.net" || tx != "Choose Chat with Agit8or.net to read and reply." {
		t.Errorf("balloon %q %q", ti, tx)
	}
	if connectingTip(tray.Brand{Provider: "Agit8or.net"}) != "Connecting to Agit8or.net…" {
		t.Error(connectingTip(tray.Brand{Provider: "Agit8or.net"}))
	}
	if chatTitle(tray.Brand{Business: "MSP Reboot", Provider: "Agit8or.net"}) != "Chat with Agit8or.net — MSP Reboot" {
		t.Error(chatTitle(tray.Brand{Business: "MSP Reboot", Provider: "Agit8or.net"}))
	}
	if tooltip(s) != "Support for MSP Reboot (offline)" {
		t.Error(tooltip(s))
	}

	// Nobody named: the generic wording.
	g := tray.State{RecordNew: true, Offline: true}
	if menuLabel(g) != "Chat with support" || chatTitle(tray.Brand{}) != "Chat with support" || connectingTip(tray.Brand{}) != "Connecting to your IT provider…" || tooltip(tray.State{}) != "Support" {
		t.Error("generic wording")
	}
	if a := aboutText(g); !strings.Contains(a, "your IT provider keeps a transcript") || !strings.Contains(a, "Your IT provider's portal cannot be reached") {
		t.Errorf("generic about %q", a)
	}
	if ti, _ := newMessageBalloon(g); ti != "New message from support" {
		t.Error(ti)
	}
	if tooltip(tray.State{Provider: "Agit8or.net"}) != "Support from Agit8or.net" {
		t.Error(tooltip(tray.State{Provider: "Agit8or.net"}))
	}
}

func TestTooltipLimit(t *testing.T) {
	// 64 astral-plane characters are 128 UTF-16 units: over the limit by themselves.
	s := tray.State{Business: strings.Repeat("😀", 64), Offline: true, Chat: tray.ChatState{Unread: []string{"a", "b", "c"}}}
	tip := tooltip(s)
	if u16len(tip) > maxTip || !strings.HasSuffix(tip, " (offline) — 3 new message(s)") || !strings.Contains(tip, "…") {
		t.Errorf("tooltip %d units: %q", u16len(tip), tip)
	}
	// Never half a surrogate pair.
	for n := 0; n < 20; n++ {
		c := clipU16(strings.Repeat("😀", 10), n)
		if u16len(c) > n || strings.ContainsRune(c, '�') {
			t.Errorf("clip %d: %q", n, c)
		}
	}
	if clipU16("short", 127) != "short" {
		t.Error("clipped a short string")
	}
	ti, tx := newMessageBalloon(tray.State{Provider: strings.Repeat("P", 64)})
	if u16len(ti) > maxBalloonTitle || u16len(tx) > maxBalloonText {
		t.Errorf("balloon %d %d", u16len(ti), u16len(tx))
	}
}

func TestShownAndSavedBrand(t *testing.T) {
	last := tray.Brand{Business: "MSP Reboot", Provider: "Agit8or.net", SupportText: "Call", Accent: "#112233"}
	// Before the first answer: the last-known brand.
	if s := shownState(tray.State{}, false, last); s.Business != "MSP Reboot" || s.Provider != "Agit8or.net" {
		t.Errorf("before the first answer %+v", s)
	}
	// The host has never reached the portal: offline, no brand → last-known.
	if s := shownState(tray.State{Offline: true}, true, last); s.Business != "MSP Reboot" {
		t.Errorf("offline %+v", s)
	}
	// An answer from the portal is what it says, even if it names no one.
	if s := shownState(tray.State{}, true, last); s.Business != "" || s.Provider != "" {
		t.Errorf("online answer overridden %+v", s)
	}
	// Saved only from a portal answer that changed it, including to nobody.
	if _, w := brandToSave(tray.State{}, false, last); w {
		t.Error("saved before an answer")
	}
	if _, w := brandToSave(tray.State{Offline: true}, true, last); w {
		t.Error("saved an offline state")
	}
	if _, w := brandToSave(tray.State{Business: "MSP Reboot", Provider: "Agit8or.net", SupportText: "Call", Accent: "#112233"}, true, last); w {
		t.Error("saved an unchanged brand")
	}
	if b, w := brandToSave(tray.State{Accent: "#3B82F6"}, true, last); !w || !b.Empty() {
		t.Errorf("a computer moved out of its business keeps the old name: %+v %v", b, w)
	}
	// Nothing but the brand is saved from a state carrying everything else.
	full := tray.State{Business: "B", Provider: "P", Portal: "portal.example.com", Version: "0.53.1",
		Chat: tray.ChatState{Open: true, ConversationID: "clx0000000000000000000001", Unread: []string{"clx0000000000000000000009"}}}
	b, _ := brandToSave(full, true, tray.Brand{})
	raw := string(tray.MarshalBrand(b))
	for _, leak := range []string{"portal.example.com", "clx", "0.53.1"} {
		if strings.Contains(raw, leak) {
			t.Errorf("brand file carries %q: %s", leak, raw)
		}
	}
}

func TestBrandFileOnDisk(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Rem0te")
	if b := loadBrand(dir); !b.Empty() {
		t.Error("a missing file is a brand")
	}
	want := tray.Brand{Business: "MSP Reboot", Provider: "Agit8or.net", SupportText: "Call", Accent: "#112233"}
	if err := saveBrand(dir, want); err != nil {
		t.Fatal(err)
	}
	if got := loadBrand(dir); got != want {
		t.Errorf("%+v", got)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}
	// A bad or oversized file is no brand.
	for _, bad := range []string{"garbage", `{"business":"x","trayKey":"tk_y"}`, `{"business":"` + strings.Repeat("a", tray.MaxBrandFileBytes+10) + `"}`} {
		if err := os.WriteFile(filepath.Join(dir, brandFileName), []byte(bad), 0o600); err != nil {
			t.Fatal(err)
		}
		if b := loadBrand(dir); !b.Empty() {
			t.Errorf("read %+v from %.40q", b, bad)
		}
	}
	if loadBrand("") != (tray.Brand{}) || saveBrand("", want) != nil {
		t.Error("no folder")
	}
}
