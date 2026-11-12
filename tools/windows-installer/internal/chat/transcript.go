package chat

import (
	"strings"
	"time"
)

// Transcript is the chat window's model: what it shows, and which technician
// messages it has yet to report as shown or read. The Win32 code only draws
// Render() and forwards Acks(); everything that decides is here, and tested.
type Transcript struct {
	lines    []line
	byID     map[string]int
	byCID    map[string]int
	shown    map[string]bool // reported shown
	read     map[string]bool // reported read
	Now      func() time.Time
	Location *time.Location
	// Header, once the host has said who this is.
	Business, Technician string
	Ended                bool
	EndReason            string
}

type line struct {
	id, cid, from, name, text string
	at                        time.Time
	pending, failed           bool
	reason                    string
}

// MaxLines kept on screen; older ones scroll off (the portal keeps them all).
const MaxLines = 300

func NewTranscript() *Transcript {
	return &Transcript{byID: map[string]int{}, byCID: map[string]int{}, shown: map[string]bool{}, read: map[string]bool{}, Now: time.Now, Location: time.Local}
}

func (t *Transcript) reindex() {
	t.byID, t.byCID = map[string]int{}, map[string]int{}
	for i, l := range t.lines {
		if l.id != "" {
			t.byID[l.id] = i
		}
		if l.cid != "" {
			t.byCID[l.cid] = i
		}
	}
}

func (t *Transcript) push(l line) {
	t.lines = append(t.lines, l)
	if len(t.lines) > MaxLines {
		t.lines = t.lines[len(t.lines)-MaxLines:]
	}
	t.reindex()
}

// Apply takes one frame the host sent (already through CheckFromHost) and
// reports whether the view changed.
func (t *Transcript) Apply(f Frame) bool {
	switch f.T {
	case FrameHeader:
		t.Business, t.Technician = f.Business, f.Technician
		return true
	case FrameMsg:
		if _, dup := t.byID[f.ID]; dup {
			return false // a message re-sent because its receipt was not confirmed yet
		}
		at, err := time.Parse(time.RFC3339Nano, f.At)
		if err != nil {
			at = t.Now()
		}
		t.push(line{id: f.ID, from: f.From, name: f.Name, text: f.Text, at: at})
		return true
	case FrameSent:
		if i, ok := t.byCID[f.CID]; ok {
			if _, dup := t.byID[f.ID]; dup && t.lines[t.byID[f.ID]].cid != f.CID {
				// The history already carried it: drop the local copy.
				t.lines = append(t.lines[:i], t.lines[i+1:]...)
				t.reindex()
				return true
			}
			t.lines[i].id, t.lines[i].pending, t.lines[i].failed = f.ID, false, false
			t.reindex()
			return true
		}
	case FrameFailed:
		if i, ok := t.byCID[f.CID]; ok {
			t.lines[i].pending, t.lines[i].failed, t.lines[i].reason = false, true, f.Reason
			return true
		}
	case FrameEnd:
		t.Ended, t.EndReason = true, f.Reason
		return true
	}
	return false
}

// Local adds what the person just typed, as sending, under its client id.
func (t *Transcript) Local(cid, text string) {
	t.push(line{cid: cid, from: "user", name: "You", text: text, at: t.Now(), pending: true})
}

// Acks are the technician messages to report now: shown if the window is
// visible (not minimised), read if it is also the foreground window. Each id
// is reported once per kind.
func (t *Transcript) Acks(visible, foreground bool) (shown, read []string) {
	if !visible {
		return nil, nil
	}
	for _, l := range t.lines {
		if l.from != "technician" || l.id == "" {
			continue
		}
		if !t.shown[l.id] {
			t.shown[l.id] = true
			shown = append(shown, l.id)
		}
		if foreground && !t.read[l.id] {
			t.read[l.id] = true
			read = append(read, l.id)
		}
	}
	return shown, read
}

// Title is the window title: the business, so the taskbar says who it is.
func (t *Transcript) Title() string {
	if t.Business == "" {
		return "Support chat"
	}
	return "Support chat - " + t.Business
}

// Banner is the line at the top of the window, in plain words: who is
// writing, for which business, and what they will never ask for.
func (t *Transcript) Banner() string {
	if t.Technician == "" {
		return "Connecting to your IT support..."
	}
	return t.Technician + " from " + t.Business + " support is chatting with you.\r\n" +
		"Opened by the Rem0te agent your IT provider installed. They will never ask for your password here, and links are never opened for you."
}

// EndText is the status line once the chat is over.
func (t *Transcript) EndText() string {
	switch t.EndReason {
	case "technician":
		return "The technician ended this chat. You can close this window."
	case "inactive":
		return "This chat ended after two hours without messages. You can close this window."
	case "":
		return ""
	default:
		return "This chat has ended. You can close this window."
	}
}

// Render is the transcript as the read-only edit control shows it: plain
// text, CRLF line ends, nothing that could be a control sequence.
func (t *Transcript) Render() string {
	var b strings.Builder
	for i, l := range t.lines {
		if i > 0 {
			b.WriteString("\r\n")
		}
		who := l.name
		switch {
		case l.from == "user" && l.name == "You":
		case l.from == "user":
			who = "You (" + l.name + ")"
		case who == "":
			who = "Technician"
		}
		b.WriteString(who)
		b.WriteString("  ")
		b.WriteString(l.at.In(t.Location).Format("15:04"))
		if l.pending {
			b.WriteString("  (sending...)")
		}
		if l.failed {
			b.WriteString("  (" + CleanLine(l.reason, 120) + ")")
		}
		b.WriteString("\r\n")
		for _, s := range strings.Split(l.text, "\n") {
			b.WriteString("    ")
			b.WriteString(s)
			b.WriteString("\r\n")
		}
	}
	return b.String()
}
