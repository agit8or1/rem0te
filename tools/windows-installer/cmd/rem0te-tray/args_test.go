package main

import (
	"strings"
	"testing"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

func TestParseArgs(t *testing.T) {
	down, up := tray.PipeNames()
	nonce := tray.NewNonce()
	if o, err := parseArgs([]string{"--down", down, "--up", up, "--nonce", nonce}); err != nil || o.mode != modeSigned {
		t.Fatalf("%+v %v", o, err)
	}
	if o, err := parseArgs([]string{"--standard"}); err != nil || o.mode != modeStandard {
		t.Fatalf("%+v %v", o, err)
	}
	if o, err := parseArgs([]string{"--chat-window", "--portal", "portal.example.com"}); err != nil || o.mode != modeChatWindow {
		t.Fatalf("%+v %v", o, err)
	}
	d2, _ := tray.PipeNames()
	for _, a := range [][]string{
		{},
		{"--down", down, "--up", up},
		{"--down", up, "--up", down, "--nonce", nonce},
		{"--down", d2, "--up", up, "--nonce", nonce},
		{"--down", `\\evil\pipe\x`, "--up", up, "--nonce", nonce},
		{"--standard", "--portal", "evil.example"},
		{"--standard", "--down", down},
		{"--chat-window"},
		{"--chat-window", "--portal", "evil.example/x"},
		{"--standard", "extra"},
		{"--elevate"},
	} {
		if _, err := parseArgs(a); err == nil {
			t.Errorf("accepted %v", a)
		}
	}
}

func TestTrayFile(t *testing.T) {
	key := "tk_" + strings.Repeat("a", 24) + "." + strings.Repeat("B", 43)
	ok := `{"portal":"portal.example.com","trayKey":"` + key + `","keyId":"` + strings.Repeat("a", 24) + `"}`
	if tf, err := parseTrayFile([]byte("\xef\xbb\xbf" + ok)); err != nil || tf.Portal != "portal.example.com" {
		t.Fatalf("%+v %v", tf, err)
	}
	for _, bad := range []string{"", "{}", `{"portal":"evil/x","trayKey":"` + key + `","keyId":"` + strings.Repeat("a", 24) + `"}`,
		`{"portal":"portal.example.com","trayKey":"` + key + `","keyId":"` + strings.Repeat("b", 24) + `"}`,
		`{"portal":"portal.example.com","trayKey":"agentSecret","keyId":"x"}`} {
		if _, err := parseTrayFile([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestChatURL(t *testing.T) {
	code := strings.Repeat("A", 43)
	good := "https://portal.example.com/assist/open?c=" + code
	if u, err := chatURL("portal.example.com", strings.NewReader(good+"\r\n")); err != nil || u != good {
		t.Fatalf("%q %v", u, err)
	}
	for _, bad := range []string{"", "https://evil.example/assist/open?c=" + code, "https://portal.example.com/dashboard",
		good + "&next=https://evil.example", "http://portal.example.com/assist/open?c=" + code, "file:///C:/x"} {
		if _, err := chatURL("portal.example.com", strings.NewReader(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestLabels(t *testing.T) {
	s := tray.State{Business: "Acme", Provider: "Prov", SupportText: "Support: 555", Agent: "signed", Version: "0.36.0", RecordNew: false}
	if a := aboutText(s); !strings.Contains(a, "Acme") || !strings.Contains(a, "Signed agent, 0.36.0") || !strings.Contains(a, "not recorded") {
		t.Errorf("about %q", a)
	}
	s.Chat.Unread = []string{"a", "b"}
	if menuLabel(s) != "Chat with support (2 new messages)" {
		t.Error(menuLabel(s))
	}
	if toolLabel(tray.ToolState{Title: "Renew IP address", Blocked: "x"}) != "Renew IP address (paused by your IT provider)" {
		t.Error("blocked label")
	}
}
