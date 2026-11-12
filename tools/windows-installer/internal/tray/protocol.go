// Package tray is the platform-independent part of the tray (0.36): the tray
// icon that runs in every signed-in session on a managed Windows computer, and
// — on the signed agent — the SYSTEM tray host that speaks for it.
//
//	signed agent
//	  portal ── HTTPS, device secret ──▶ tray host (SYSTEM, `rem0te-agent.exe tray-host`)
//	                                        │ two named pipes per session, ACL'd to that
//	                                        │ session's user, first instance, local only,
//	                                        │ client PID checked, a per-launch nonce first
//	                                        ▼
//	                                     tray (the user, `rem0te-tray.exe --down P --up P --nonce N`)
//
//	standard agent
//	  portal ── HTTPS, tray key ──▶ tray (the user, `rem0te-tray.exe --standard`, Run key)
//
// The tray never holds the device secret. On the signed agent it holds no
// credential at all: it asks the host, which mints a one-time chat code,
// sends a support request, or runs a self-help tool from a closed catalog.
// On the standard agent it holds the tray key, which the portal accepts only
// for what the person at the computer can do through the tray.
//
// Everything that decides is here, and tested; the Windows calls are in the
// _windows.go files and in cmd/rem0te-tray.
package tray

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

// ProtocolVersion is what agent-status.json reports as `tray` (signed agent)
// and what the standard heartbeat reports as agentTray once its tray is in place.
const ProtocolVersion = 1

// Frame size limits. A support frame carries a base64 screenshot (at most
// MaxScreenshotBytes decoded); every other frame is small.
const (
	MaxFrameBytes        = 16 << 10
	MaxSupportFrameBytes = 1 << 20
	MaxScreenshotBytes   = 700 << 10 // the portal's SCREENSHOT_MAX_BYTES
)

// Frame types.
const (
	// tray → host
	FrameHello    = "hello"    // first frame: the nonce from the command line
	FrameCode     = "code"     // open the chat: mint a one-time code (ID)
	FrameSupport  = "support"  // a support request: ID, Text, Usage, Shot
	FrameSelfHelp = "selfhelp" // run a tool: ID, Tool
	FrameSeen     = "seen"     // the tray showed these unread technician messages (badge or balloon): IDs
	// host → tray
	FrameState = "state" // State
	FrameReply = "reply" // the answer to ID: OK, Reason, URL, Outcome, Summary, Lines
)

// Frame is one line of JSON on a pipe. Unknown fields are refused.
type Frame struct {
	T       string   `json:"t"`
	Nonce   string   `json:"nonce,omitempty"`
	ID      string   `json:"id,omitempty"`
	Text    string   `json:"text,omitempty"`
	Usage   bool     `json:"usage,omitempty"`
	Shot    string   `json:"shot,omitempty"`
	Tool    string   `json:"tool,omitempty"`
	IDs     []string `json:"ids,omitempty"`
	OK      bool     `json:"ok,omitempty"`
	Reason  string   `json:"reason,omitempty"`
	URL     string   `json:"url,omitempty"`
	Outcome string   `json:"outcome,omitempty"`
	Summary string   `json:"summary,omitempty"`
	Lines   []string `json:"lines,omitempty"`
	State   *State   `json:"state,omitempty"`
}

// State is what the tray shows: who it is for, whether a chat is open (and
// unread), whether chat is recorded, what is paused, and which tools exist.
// It comes from the portal; the tray draws nothing a message can set.
type State struct {
	Business    string      `json:"business"`
	Provider    string      `json:"provider"`
	SupportText string      `json:"supportText"`
	Accent      string      `json:"accent"`
	Agent       string      `json:"agent"` // signed | standard
	Version     string      `json:"version"`
	Portal      string      `json:"portal"`
	HasBusiness bool        `json:"hasBusiness"`
	Chat        ChatState   `json:"chat"`
	RecordNew   bool        `json:"recordNew"`
	Remote      string      `json:"remote,omitempty"`  // a `remote` pause, in words
	Actions     string      `json:"actions,omitempty"` // an `actions` pause, in words
	Tools       []ToolState `json:"tools"`
	Console     bool        `json:"console"` // this session is the one at the screen
	Offline     bool        `json:"offline"` // the portal could not be reached
}

type ChatState struct {
	Open           bool     `json:"open"`
	ConversationID string   `json:"conversationId,omitempty"`
	StartedBy      string   `json:"startedBy,omitempty"`
	Recorded       bool     `json:"recorded"`
	Unread         []string `json:"unread,omitempty"`
	AutoOpen       bool     `json:"autoOpen,omitempty"`
	OtherUser      bool     `json:"otherUser,omitempty"`
}

type ToolState struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Elevated bool   `json:"elevated"`
	Blocked  string `json:"blocked,omitempty"`
}

var (
	idRE    = regexp.MustCompile(`^[a-z0-9]{20,40}$`)
	reqRE   = regexp.MustCompile(`^[a-f0-9]{8,32}$`)
	nonceRE = regexp.MustCompile(`^[0-9a-f]{64}$`)
	b64RE   = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)
	// ErrFrame is any frame that is not one the other side may send.
	ErrFrame = errors.New("refused tray frame")
)

// ValidID is a portal id (cuid).
func ValidID(s string) bool { return idRE.MatchString(s) }

// ValidNonce is the per-launch tray nonce (32 random bytes, hex).
func ValidNonce(s string) bool { return nonceRE.MatchString(s) }

// WriteFrame writes one frame and a newline.
func WriteFrame(w io.Writer, f Frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	limit := MaxFrameBytes
	if f.T == FrameSupport {
		limit = MaxSupportFrameBytes
	}
	if len(b)+1 > limit {
		return fmt.Errorf("%w: frame of %d bytes", ErrFrame, len(b))
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

// Reader reads frames, refusing any line over MaxSupportFrameBytes, and any
// frame but a support frame over MaxFrameBytes.
type Reader struct{ r *bufio.Reader }

func NewReader(r io.Reader) *Reader { return &Reader{r: bufio.NewReaderSize(r, 4096)} }

// Next returns the next frame, io.EOF at the end, or ErrFrame for a line that
// is too long, is not JSON, carries an unknown field or trailing data.
func (r *Reader) Next() (Frame, error) {
	var line []byte
	for {
		chunk, err := r.r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > MaxSupportFrameBytes {
			return Frame{}, fmt.Errorf("%w: line over %d bytes", ErrFrame, MaxSupportFrameBytes)
		}
		if err == nil {
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(line) > 0 {
			return Frame{}, fmt.Errorf("%w: unterminated frame", ErrFrame)
		}
		return Frame{}, err
	}
	d := json.NewDecoder(bytes.NewReader(line))
	d.DisallowUnknownFields()
	var f Frame
	if err := d.Decode(&f); err != nil {
		return Frame{}, fmt.Errorf("%w: %v", ErrFrame, err)
	}
	if d.More() {
		return Frame{}, fmt.Errorf("%w: trailing data", ErrFrame)
	}
	if f.T != FrameSupport && len(line) > MaxFrameBytes {
		return Frame{}, fmt.Errorf("%w: %s frame of %d bytes", ErrFrame, f.T, len(line))
	}
	return f, nil
}

func onlyFields(f Frame, allowed ...string) error {
	set := map[string]bool{}
	for _, a := range allowed {
		set[a] = true
	}
	present := map[string]bool{
		"nonce": f.Nonce != "", "id": f.ID != "", "text": f.Text != "", "usage": f.Usage, "shot": f.Shot != "", "tool": f.Tool != "",
		"ids": len(f.IDs) > 0, "ok": f.OK, "reason": f.Reason != "", "url": f.URL != "", "outcome": f.Outcome != "",
		"summary": f.Summary != "", "lines": len(f.Lines) > 0, "state": f.State != nil,
	}
	for k, v := range present {
		if v && !set[k] {
			return fmt.Errorf("%w: %s frame carries %s", ErrFrame, f.T, k)
		}
	}
	return nil
}

// CheckFromTray is the host's rule for what a tray may say. Only the fields
// its type uses may be set; a tool must be in the catalog; a screenshot must
// be base64 within the cap. The tray is code running as an unprivileged user
// — anything else closes it.
func CheckFromTray(f Frame) (Frame, error) {
	needID := func() error {
		if !reqRE.MatchString(f.ID) {
			return fmt.Errorf("%w: bad request id", ErrFrame)
		}
		return nil
	}
	switch f.T {
	case FrameHello:
		if err := onlyFields(f, "nonce"); err != nil {
			return Frame{}, err
		}
		if !ValidNonce(f.Nonce) {
			return Frame{}, fmt.Errorf("%w: bad nonce", ErrFrame)
		}
	case FrameCode:
		if err := onlyFields(f, "id"); err != nil {
			return Frame{}, err
		}
		if err := needID(); err != nil {
			return Frame{}, err
		}
	case FrameSupport:
		if err := onlyFields(f, "id", "text", "usage", "shot"); err != nil {
			return Frame{}, err
		}
		if err := needID(); err != nil {
			return Frame{}, err
		}
		t, err := CleanRequestText(f.Text)
		if err != nil {
			return Frame{}, err
		}
		f.Text = t
		if f.Shot != "" && (!b64RE.MatchString(f.Shot) || len(f.Shot) > (MaxScreenshotBytes*4)/3+4) {
			return Frame{}, fmt.Errorf("%w: screenshot is not base64 within %d bytes", ErrFrame, MaxScreenshotBytes)
		}
	case FrameSelfHelp:
		if err := onlyFields(f, "id", "tool"); err != nil {
			return Frame{}, err
		}
		if err := needID(); err != nil {
			return Frame{}, err
		}
		if _, ok := Tool(f.Tool); !ok {
			return Frame{}, fmt.Errorf("%w: %q is not a self-help tool", ErrFrame, f.Tool)
		}
	case FrameSeen:
		if err := onlyFields(f, "ids"); err != nil {
			return Frame{}, err
		}
		if len(f.IDs) == 0 || len(f.IDs) > 100 {
			return Frame{}, fmt.Errorf("%w: %d ids", ErrFrame, len(f.IDs))
		}
		for _, id := range f.IDs {
			if !ValidID(id) {
				return Frame{}, fmt.Errorf("%w: bad id", ErrFrame)
			}
		}
	default:
		return Frame{}, fmt.Errorf("%w: type %q", ErrFrame, f.T)
	}
	return f, nil
}

// CheckFromHost is the tray's rule for what the host may say. It draws
// nothing that has not passed it.
func CheckFromHost(f Frame) (Frame, error) {
	switch f.T {
	case FrameState:
		if err := onlyFields(f, "state"); err != nil {
			return Frame{}, err
		}
		if f.State == nil {
			return Frame{}, fmt.Errorf("%w: state frame without a state", ErrFrame)
		}
		s := CleanState(*f.State)
		f.State = &s
	case FrameReply:
		if err := onlyFields(f, "id", "ok", "reason", "url", "outcome", "summary", "lines"); err != nil {
			return Frame{}, err
		}
		if !reqRE.MatchString(f.ID) {
			return Frame{}, fmt.Errorf("%w: bad reply id", ErrFrame)
		}
		f.Reason, f.Summary = CleanLine(f.Reason, 300), CleanLine(f.Summary, 300)
		f.Lines = cleanLines(f.Lines)
		if f.Outcome != "" && f.Outcome != OutcomeSucceeded && f.Outcome != OutcomeFailed && f.Outcome != OutcomeRefused {
			return Frame{}, fmt.Errorf("%w: outcome %q", ErrFrame, f.Outcome)
		}
	default:
		return Frame{}, fmt.Errorf("%w: type %q", ErrFrame, f.T)
	}
	return f, nil
}

// CleanState makes every string the tray draws inert, and drops unread ids
// that are not portal ids and tools not in the catalog.
func CleanState(s State) State {
	s.Business, s.Provider = CleanLine(s.Business, 64), CleanLine(s.Provider, 64)
	s.SupportText = CleanLine(s.SupportText, 200)
	if !accentRE.MatchString(s.Accent) {
		s.Accent = "#3B82F6"
	}
	if s.Agent != "signed" {
		s.Agent = "standard"
	}
	s.Version = CleanLine(s.Version, 32)
	if !ValidPortal(s.Portal) {
		s.Portal = ""
	}
	s.Remote, s.Actions = CleanLine(s.Remote, 300), CleanLine(s.Actions, 300)
	if !ValidID(s.Chat.ConversationID) {
		s.Chat.ConversationID = ""
	}
	var ids []string
	for _, id := range s.Chat.Unread {
		if ValidID(id) && len(ids) < 100 {
			ids = append(ids, id)
		}
	}
	s.Chat.Unread = ids
	if s.Chat.StartedBy != "technician" && s.Chat.StartedBy != "end_user" {
		s.Chat.StartedBy = ""
	}
	var tools []ToolState
	for _, t := range s.Tools {
		def, ok := Tool(t.ID)
		if !ok {
			continue
		}
		tools = append(tools, ToolState{ID: def.ID, Title: def.Title, Elevated: def.Elevated, Blocked: CleanLine(t.Blocked, 300)})
	}
	s.Tools = tools
	return s
}

var accentRE = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

func cleanLines(in []string) []string {
	var out []string
	for _, l := range in {
		if len(out) >= 60 {
			break
		}
		out = append(out, CleanLine(l, 200))
	}
	return out
}
