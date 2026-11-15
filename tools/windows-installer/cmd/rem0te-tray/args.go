// rem0te-tray (0.36) is the tray icon both agents run in each signed-in
// session on Windows: chat with support, a support request, self-help tools,
// and About. It runs as the signed-in user, unelevated, and never asks to
// elevate.
//
//	rem0te-tray.exe --down P --up P --nonce N   signed agent: started by the SYSTEM tray host, speaks to it over two pipes
//	rem0te-tray.exe --standard                  standard agent: started at sign-in by the HKLM Run value, holds the tray key
//	rem0te-tray.exe --chat-window --portal H    the chat window (WebView2), started by the tray; reads the one URL from stdin
//
// Linux and macOS are not supported: there is no tray program for them.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"io"
	"strings"
	"unicode/utf16"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

type mode int

const (
	modeSigned mode = iota + 1
	modeStandard
	modeChatWindow
)

type options struct {
	mode     mode
	down, up string
	nonce    string
	portal   string
}

var errUsage = errors.New("usage: rem0te-tray.exe --down P --up P --nonce N | --standard | --chat-window --portal HOST")

// parseArgs accepts exactly one of the three forms, with values only a
// tray host or the tray itself could have produced.
func parseArgs(args []string) (options, error) {
	fs := flag.NewFlagSet("rem0te-tray", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	down := fs.String("down", "", "")
	up := fs.String("up", "", "")
	nonce := fs.String("nonce", "", "")
	standard := fs.Bool("standard", false, "")
	chatWin := fs.Bool("chat-window", false, "")
	portal := fs.String("portal", "", "")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return options{}, errUsage
	}
	switch {
	case *standard && !*chatWin && *down == "" && *up == "" && *nonce == "" && *portal == "":
		return options{mode: modeStandard}, nil
	case *chatWin && !*standard && *down == "" && *up == "" && *nonce == "":
		if !tray.ValidPortal(*portal) {
			return options{}, errUsage
		}
		return options{mode: modeChatWindow, portal: *portal}, nil
	case !*standard && !*chatWin && *portal == "":
		if !tray.ValidPipeName(*down) || !tray.ValidPipeName(*up) || !strings.HasSuffix(*down, "-down") || !strings.HasSuffix(*up, "-up") ||
			strings.TrimSuffix(*down, "-down") != strings.TrimSuffix(*up, "-up") || !tray.ValidNonce(*nonce) {
			return options{}, errUsage
		}
		return options{mode: modeSigned, down: *down, up: *up, nonce: *nonce}, nil
	}
	return options{}, errUsage
}

// trayFile is C:\ProgramData\Rem0te\tray\tray.json, written by the standard
// agent's SYSTEM heartbeat after it paired the tray (POST /tray/pair).
type trayFile struct {
	Portal  string `json:"portal"`
	TrayKey string `json:"trayKey"`
	KeyID   string `json:"keyId"`
}

func parseTrayFile(raw []byte) (trayFile, error) {
	raw = []byte(strings.TrimPrefix(string(raw), "\xef\xbb\xbf"))
	var t trayFile
	if err := json.Unmarshal(raw, &t); err != nil {
		return trayFile{}, errors.New("tray.json is not readable")
	}
	if !tray.ValidPortal(t.Portal) || !tray.ValidTrayKey(t.TrayKey) || !strings.HasPrefix(t.TrayKey, "tk_"+t.KeyID+".") {
		return trayFile{}, errors.New("tray.json does not hold a valid portal and tray key")
	}
	return t, nil
}

// chatURL is the one line the chat window reads from stdin: an /assist/open
// link on the portal named on its command line, nothing else.
func chatURL(portal string, r io.Reader) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, 512))
	if err != nil {
		return "", err
	}
	u := strings.TrimSpace(string(b))
	if !strings.HasPrefix(u, "https://"+portal+"/assist/open?c=") {
		return "", errors.New("the chat window was given a link it does not open")
	}
	code := strings.TrimPrefix(u, "https://"+portal+"/assist/open?c=")
	if want, err := tray.AssistURL(portal, code); err != nil || want != u {
		return "", errors.New("the chat window was given a link it does not open")
	}
	return u, nil
}

// ── What the tray says (0.53.1) ─────────────────────────────────────────────
//
// Every name below is from the portal's records (State, or the last-known
// Brand file, re-cleaned on read): the business is the computer's business,
// the provider is the IT provider's account name. Where the portal named no
// one the tray falls back to "support" / "your IT provider".

// Windows limits: a notification icon's tooltip is 128 UTF-16 units with the
// terminator, a balloon title 64 and its text 256. Menu items have no hard
// limit, but a long one makes the whole menu that wide.
const (
	maxTip          = 127
	maxBalloonTitle = 63
	maxBalloonText  = 255
	maxMenuText     = 80
	maxWindowTitle  = 120
)

// clipU16 cuts s to at most n UTF-16 units, never between the two halves of
// a surrogate pair, ending in "…" when it cut.
func clipU16(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(utf16.Encode([]rune(s))) <= n {
		return s
	}
	var out []rune
	used := 1 // room for the ellipsis
	for _, r := range s {
		w := utf16.RuneLen(r)
		if w < 1 {
			w = 1
		}
		if used+w > n {
			break
		}
		out = append(out, r)
		used += w
	}
	return strings.TrimRight(string(out), " ") + "…"
}

// menuText is a label as a Win32 menu shows it: "&" is a mnemonic prefix
// there, so a business called "A&B" would otherwise show as "AB".
func menuText(s string) string {
	return strings.ReplaceAll(clipU16(s, maxMenuText), "&", "&&")
}

// menuHeader is the disabled lines at the top of the menu: who this computer
// is for and who supports it, then the support contact. Empty parts are left
// out; nothing at all when the portal named no one.
func menuHeader(s tray.State) []string {
	var who string
	switch {
	case s.Business != "" && s.Provider != "":
		who = s.Business + " · supported by " + s.Provider
	case s.Business != "":
		who = s.Business
	case s.Provider != "":
		who = "Supported by " + s.Provider
	}
	var out []string
	if who != "" {
		out = append(out, menuText(who))
	}
	if s.SupportText != "" {
		out = append(out, menuText(s.SupportText))
	}
	return out
}

// chatWith is "Chat with Agit8or.net", or "Chat with support".
func chatWith(s tray.State) string {
	if s.Provider != "" {
		return "Chat with " + s.Provider
	}
	return "Chat with support"
}

// menuLabel is the chat entry with its unread badge, as plain text (the
// menu passes it through menuText).
func menuLabel(s tray.State) string {
	l := chatWith(s)
	switch {
	case len(s.Chat.Unread) == 1:
		l += " (1 new message)"
	case len(s.Chat.Unread) > 1:
		l += " (" + itoa(len(s.Chat.Unread)) + " new messages)"
	case s.Chat.Open:
		l += " (open)"
	}
	return l
}

// tooltip is the notification icon's tooltip, within its 127 units: the name
// is cut first, so "(offline)" and the unread count always fit.
func tooltip(s tray.State) string {
	suffix := ""
	if s.Offline {
		suffix += " (offline)"
	}
	if n := len(s.Chat.Unread); n > 0 {
		suffix += " — " + itoa(n) + " new message(s)"
	}
	tip := "Support"
	if s.Business != "" {
		tip = "Support for " + s.Business
	} else if s.Provider != "" {
		tip = "Support from " + s.Provider
	}
	return clipU16(tip, maxTip-len(utf16.Encode([]rune(suffix)))) + suffix
}

// connectingTip is the tooltip before the first answer.
func connectingTip(b tray.Brand) string {
	return clipU16("Connecting to "+tray.ProviderOr(b.Provider)+"…", maxTip)
}

// newMessageBalloon is the notification when a technician writes.
func newMessageBalloon(s tray.State) (title, text string) {
	who := "support"
	if s.Provider != "" {
		who = s.Provider
	}
	return clipU16("New message from "+who, maxBalloonTitle),
		clipU16("Choose "+chatWith(s)+" to read and reply.", maxBalloonText)
}

// chatTitle is the chat window's title: "Chat with Agit8or.net — MSP Reboot".
func chatTitle(b tray.Brand) string {
	t := "Chat with support"
	if b.Provider != "" {
		t = "Chat with " + b.Provider
	}
	if b.Business != "" {
		t += " — " + b.Business
	}
	return clipU16(t, maxWindowTitle)
}

func itoa(n int) string {
	if n > 99 {
		return "99+"
	}
	b, _ := json.Marshal(n)
	return string(b)
}

// aboutText is About: from the portal's records only.
func aboutText(s tray.State) string {
	var b strings.Builder
	biz := s.Business
	if biz == "" {
		biz = "This computer"
	}
	b.WriteString(biz + "\n")
	if s.Provider != "" {
		b.WriteString("Supported by " + s.Provider + "\n")
	}
	if s.SupportText != "" {
		b.WriteString(s.SupportText + "\n")
	}
	b.WriteString("\n")
	agentName := "Standard agent"
	if s.Agent == "signed" {
		agentName = "Signed agent"
	}
	b.WriteString(agentName)
	if s.Version != "" {
		b.WriteString(", " + s.Version)
	}
	b.WriteString("\n")
	if s.RecordNew {
		b.WriteString("Chats are recorded: " + tray.ProviderOr(s.Provider) + " keeps a transcript.\n")
	} else {
		b.WriteString("Chats are not recorded: messages are deleted once both sides have them.\n")
	}
	if s.Offline {
		b.WriteString("\n" + tray.ProviderTitle(s.Provider) + "'s portal cannot be reached right now.\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// toolLabel is a self-help entry, with why it is unavailable.
func toolLabel(t tray.ToolState, provider string) string {
	if t.Blocked != "" {
		return t.Title + " (paused by " + tray.ProviderOr(provider) + ")"
	}
	return t.Title
}

// shownState is what the tray draws: the portal's state, with the
// last-known brand filled in while the portal has not named anyone yet —
// before the first answer, or while the host has never reached the portal.
func shownState(s tray.State, have bool, last tray.Brand) tray.State {
	if !have || s.Offline {
		return tray.WithBrand(s, last)
	}
	return s
}

// brandToSave is the brand to write after a state, and whether to write it:
// only from an answer the portal gave (never an offline state), and only
// when it changed — including to nobody, so a computer moved out of a
// business stops naming it.
func brandToSave(s tray.State, have bool, saved tray.Brand) (tray.Brand, bool) {
	if !have || s.Offline {
		return tray.Brand{}, false
	}
	b := tray.BrandOf(s)
	return b, b != saved
}

// resultText is a self-help run as a message box shows it.
func resultText(r tray.Result) string {
	var b strings.Builder
	b.WriteString(r.Summary)
	if len(r.Lines) > 0 {
		b.WriteString("\n\n")
		lines := r.Lines
		if len(lines) > 30 {
			lines = lines[:30]
		}
		b.WriteString(strings.Join(lines, "\n"))
	}
	return b.String()
}
