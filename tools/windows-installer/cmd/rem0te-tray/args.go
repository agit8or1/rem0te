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

// menuLabel is the chat entry with its unread badge.
func menuLabel(s tray.State) string {
	switch {
	case len(s.Chat.Unread) == 1:
		return "Chat with support (1 new message)"
	case len(s.Chat.Unread) > 1:
		return "Chat with support (" + itoa(len(s.Chat.Unread)) + " new messages)"
	case s.Chat.Open:
		return "Chat with support (open)"
	}
	return "Chat with support"
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
		b.WriteString("Chats are recorded: your IT provider keeps a transcript.\n")
	} else {
		b.WriteString("Chats are not recorded: messages are deleted once both sides have them.\n")
	}
	if s.Offline {
		b.WriteString("\nYour IT provider's portal cannot be reached right now.\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// toolLabel is a self-help entry, with why it is unavailable.
func toolLabel(t tray.ToolState) string {
	if t.Blocked != "" {
		return t.Title + " (paused by your IT provider)"
	}
	return t.Title
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
