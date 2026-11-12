package chat

import (
	"errors"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// MaxMessageChars is the portal's limit (apps/api/src/chat/chat-policy.ts
// MAX_MESSAGE_CHARS), counted the same way: UTF-16 code units.
const MaxMessageChars = 2000

var (
	ErrEmpty   = errors.New("empty message")
	ErrTooLong = errors.New("message over 2,000 characters")
)

// isControl: C0 and C1 controls except tab and newline, DEL, the Unicode line
// and paragraph separators, and the bidirectional overrides and isolates —
// the same ranges the portal strips (chat-policy.ts CONTROL_RANGES).
func isControl(r rune) bool {
	switch {
	case r <= 0x08, r >= 0x0b && r <= 0x1f, r >= 0x7f && r <= 0x9f:
		return true
	case r >= 0x2028 && r <= 0x2029, r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

func strip(s, by string) string {
	var b strings.Builder
	for _, r := range s {
		if r == utf8.RuneError {
			b.WriteString(by)
			continue
		}
		if isControl(r) {
			b.WriteString(by)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// CleanText is a message body as both ends store and show it: CRLF and CR to
// LF, controls and invalid UTF-8 dropped, at most 20 blank lines in a row,
// trimmed; empty or over the limit is refused (never cut).
func CleanText(s string) (string, error) {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strip(s, "")
	for strings.Contains(s, strings.Repeat("\n", 21)) {
		s = strings.ReplaceAll(s, strings.Repeat("\n", 21), strings.Repeat("\n", 20))
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", ErrEmpty
	}
	if utf16Len(s) > MaxMessageChars {
		return "", ErrTooLong
	}
	return s, nil
}

// CleanLine is one line of display text: controls, tabs and newlines become
// spaces, runs of spaces one, at most max runes.
func CleanLine(s string, max int) string {
	s = strip(s, " ")
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return strings.TrimSpace(s)
}

// CleanName is a person's or business's name as the window shows it.
func CleanName(s string) string { return CleanLine(s, 64) }

// ForEdit converts LF to CRLF for a Win32 edit control, which shows a bare LF
// as nothing at all.
func ForEdit(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
}

// Limiter is the host's own cap on what the window may send: at most N
// messages in any minute, the same number the portal enforces per
// conversation, so a stuck key or a flood from the session is refused before
// it reaches the network.
type Limiter struct {
	mu    sync.Mutex
	N     int
	Every time.Duration
	Now   func() time.Time
	sent  []time.Time
}

func NewLimiter(n int, every time.Duration) *Limiter {
	return &Limiter{N: n, Every: every, Now: time.Now}
}

// Allow records and allows one more, or refuses it.
func (l *Limiter) Allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	keep := l.sent[:0]
	for _, t := range l.sent {
		if now.Sub(t) < l.Every {
			keep = append(keep, t)
		}
	}
	l.sent = keep
	if len(l.sent) >= l.N {
		return false
	}
	l.sent = append(l.sent, now)
	return true
}
