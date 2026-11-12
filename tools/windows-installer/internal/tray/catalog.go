package tray

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/chat"
)

// SelfHelpTool is one entry of the closed self-help catalog. It must equal
// apps/api/src/tray/tray-policy.ts SELF_HELP and the TraySelfHelpRun_tool
// CHECK in migration 0062 — §55 of check-security-invariants.mjs compares
// all three. No tool takes a parameter from the person at the computer.
type SelfHelpTool struct {
	ID        string
	Title     string
	Elevated  bool          // runs as SYSTEM in the signed tray host; never from a tray key
	PerWindow int           // runs allowed in Window, per computer
	Window    time.Duration //
	BlockedBy []string      // containment kinds that stop it
}

// Catalog is the whole list, in the order the tray shows it.
var Catalog = []SelfHelpTool{
	{ID: "dns.check", Title: "Check DNS", Elevated: false, PerWindow: 10, Window: 10 * time.Minute},
	{ID: "dns.flush", Title: "Flush the DNS cache", Elevated: true, PerWindow: 3, Window: 10 * time.Minute, BlockedBy: []string{"actions"}},
	{ID: "ip.renew", Title: "Renew IP address", Elevated: true, PerWindow: 2, Window: 15 * time.Minute, BlockedBy: []string{"actions"}},
	{ID: "net.test", Title: "Test the connection", Elevated: false, PerWindow: 10, Window: 10 * time.Minute},
	{ID: "net.details", Title: "Show network details", Elevated: false, PerWindow: 10, Window: 10 * time.Minute},
	{ID: "rustdesk.restart", Title: "Restart the remote support service", Elevated: true, PerWindow: 2, Window: 30 * time.Minute, BlockedBy: []string{"actions", "remote"}},
}

// PerHour is every tool together, per computer (SELF_HELP_PER_HOUR).
const PerHour = 30

// Outcomes a run reports (SELF_HELP_OUTCOMES).
const (
	OutcomeSucceeded = "succeeded"
	OutcomeFailed    = "failed"
	OutcomeRefused   = "refused"
)

// Tool looks a tool up by id. Anything not in Catalog does not exist.
func Tool(id string) (SelfHelpTool, bool) {
	for _, t := range Catalog {
		if t.ID == id {
			return t, true
		}
	}
	return SelfHelpTool{}, false
}

// RenewWarning is shown before an IP renew, which drops every connection for
// a moment — a remote session included.
const RenewWarning = "Renewing the IP address disconnects this computer from the network for a few seconds. Anything that is downloading, and any remote support session, will be interrupted. Continue?"

// ── Text ─────────────────────────────────────────────────────────────────────

// CleanLine is chat.CleanLine: one inert line of display text.
func CleanLine(s string, max int) string { return chat.CleanLine(s, max) }

// MaxRequestChars is the portal's SUPPORT_MAX_TEXT.
const MaxRequestChars = 2000

var ErrRequestText = errors.New("a support request must be 1 to 2,000 characters")

// CleanRequestText is a support request's text: the chat body rules
// (controls dropped, line ends normalised, trimmed), 1–2,000 characters.
func CleanRequestText(s string) (string, error) {
	t, err := chat.CleanText(s)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRequestText, err)
	}
	if utf8.RuneCountInString(t) > MaxRequestChars {
		return "", ErrRequestText
	}
	return t, nil
}

// ── The portal ───────────────────────────────────────────────────────────────

// ValidPortal is a portal host[:port] as the agent pins it.
func ValidPortal(h string) bool { return h != "" && agent.ValidPortal(h) }

var codeRE = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// ValidCode is a one-time chat code as the portal mints it (32 random bytes, base64url).
func ValidCode(s string) bool { return codeRE.MatchString(s) }

// AssistURL is the one link the tray ever opens: the pinned portal's
// /assist/open with a one-time code. The code is spent by the first load,
// which answers with a cookie and a redirect, so the URL in the window's
// history is already dead. The tray builds it — the portal returns a code,
// never a URL, so nothing the portal says can point the window elsewhere.
func AssistURL(portal, code string) (string, error) {
	if !ValidPortal(portal) {
		return "", fmt.Errorf("no valid pinned portal")
	}
	if !ValidCode(code) {
		return "", fmt.Errorf("the portal returned a malformed chat code")
	}
	return "https://" + portal + "/assist/open?c=" + code, nil
}

// AllowedNavigation is the chat window's navigation rule: https, the pinned
// portal exactly, and a path under /assist/. Everything else is cancelled —
// a link in a message (the page never makes one, but a technician could
// paste a URL) opens nowhere.
func AllowedNavigation(portal, raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || !strings.EqualFold(u.Host, portal) {
		return false
	}
	p := u.EscapedPath()
	return strings.HasPrefix(p, "/assist/") && !strings.Contains(p, "..") && !strings.Contains(strings.ToLower(p), "%2e")
}
