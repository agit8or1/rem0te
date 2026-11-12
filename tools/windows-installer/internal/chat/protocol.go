// Package chat is the platform-independent part of the agent's chat (0.34):
// the chat host that runs as SYSTEM while a conversation is open, and the
// protocol it speaks to the unprivileged chat window in the signed-in user's
// session.
//
//	portal ── HTTPS, device secret ──▶ chat host (SYSTEM, `rem0te-agent.exe chat`)
//	                                       │  two named pipes, ACL'd to the session user,
//	                                       │  first instance, local only, client PID checked,
//	                                       │  and a per-launch nonce in the first frame
//	                                       ▼
//	                                   chat window (user, `rem0te-agent.exe chat-window`)
//
// The window never holds the device secret or talks to the network: it can
// only say what the person typed, that a message was shown or read, and that
// the window was closed. Everything it says is checked here (ParseFromWindow)
// before the host acts on it, and everything the portal sends is checked
// again before the window draws it.
package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

// ProtocolVersion is what agent-status.json reports as `chat`, and what the
// portal needs before it offers a chat on this computer.
const ProtocolVersion = 1

// MaxFrameBytes bounds one pipe frame (a 2,000-character message is at most
// 8,000 bytes of UTF-8, plus JSON).
const MaxFrameBytes = 16 << 10

// Frame types.
const (
	// window → host
	FrameHello = "hello" // first frame: the nonce from the command line
	FrameSend  = "send"  // the person typed something: CID, Text
	FrameShown = "shown" // these technician messages were drawn in a visible window: IDs
	FrameRead  = "read"  // …and the window was in the foreground: IDs
	FrameClose = "close" // the person closed the window
	// host → window
	FrameHeader = "header" // Business, Technician: who this chat is with
	FrameMsg    = "msg"    // one message: ID, From, Name, Text, At
	FrameSent   = "sent"   // CID was stored as ID
	FrameFailed = "failed" // CID was not sent: Reason
	FrameStatus = "status" // a line for the status bar: Text
	FrameEnd    = "end"    // the chat is over: Reason
)

// Frame is one line of JSON on a pipe. Unknown fields are refused.
type Frame struct {
	T          string   `json:"t"`
	Nonce      string   `json:"nonce,omitempty"`
	Business   string   `json:"business,omitempty"`
	Technician string   `json:"technician,omitempty"`
	ID         string   `json:"id,omitempty"`
	CID        string   `json:"cid,omitempty"`
	From       string   `json:"from,omitempty"`
	Name       string   `json:"name,omitempty"`
	Text       string   `json:"text,omitempty"`
	At         string   `json:"at,omitempty"`
	IDs        []string `json:"ids,omitempty"`
	Reason     string   `json:"reason,omitempty"`
}

var (
	idRE    = regexp.MustCompile(`^[a-z0-9]{20,40}$`)
	cidRE   = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	nonceRE = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// ErrFrame is any frame that is not one the other side may send.
	ErrFrame = errors.New("refused chat frame")
)

// ValidID is a portal message or conversation id (cuid).
func ValidID(s string) bool { return idRE.MatchString(s) }

// ValidCID is a client id the host makes for a reply.
func ValidCID(s string) bool { return cidRE.MatchString(s) }

// ValidNonce is the per-launch window nonce (32 random bytes, hex).
func ValidNonce(s string) bool { return nonceRE.MatchString(s) }

// WriteFrame writes one frame and a newline.
func WriteFrame(w io.Writer, f Frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	if len(b)+1 > MaxFrameBytes {
		return fmt.Errorf("%w: frame of %d bytes", ErrFrame, len(b))
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

// Reader reads frames, refusing any line over MaxFrameBytes.
type Reader struct{ r *bufio.Reader }

func NewReader(r io.Reader) *Reader { return &Reader{r: bufio.NewReaderSize(r, 4096)} }

// Next returns the next frame, io.EOF at the end, or ErrFrame for a line that
// is too long, is not JSON, carries an unknown field or trailing data.
func (r *Reader) Next() (Frame, error) {
	var line []byte
	for {
		chunk, err := r.r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > MaxFrameBytes {
			return Frame{}, fmt.Errorf("%w: line over %d bytes", ErrFrame, MaxFrameBytes)
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
	return f, nil
}

// CheckFromWindow is the host's rule for what the window may say. Only the
// fields its type uses may be set; ids must be the portal's; text must
// survive CleanText within MaxMessageChars. It returns the frame with its
// text cleaned.
func CheckFromWindow(f Frame) (Frame, error) {
	only := func(allowed ...string) error {
		set := map[string]bool{}
		for _, a := range allowed {
			set[a] = true
		}
		fields := map[string]bool{
			"nonce": f.Nonce != "", "business": f.Business != "", "technician": f.Technician != "", "id": f.ID != "",
			"cid": f.CID != "", "from": f.From != "", "name": f.Name != "", "text": f.Text != "", "at": f.At != "",
			"ids": len(f.IDs) > 0, "reason": f.Reason != "",
		}
		for k, v := range fields {
			if v && !set[k] {
				return fmt.Errorf("%w: %s frame carries %s", ErrFrame, f.T, k)
			}
		}
		return nil
	}
	switch f.T {
	case FrameHello:
		if err := only("nonce"); err != nil {
			return Frame{}, err
		}
		if !ValidNonce(f.Nonce) {
			return Frame{}, fmt.Errorf("%w: bad nonce", ErrFrame)
		}
	case FrameSend:
		if err := only("cid", "text"); err != nil {
			return Frame{}, err
		}
		if !ValidCID(f.CID) {
			return Frame{}, fmt.Errorf("%w: bad client id", ErrFrame)
		}
		t, err := CleanText(f.Text)
		if err != nil {
			return Frame{}, err
		}
		f.Text = t
	case FrameShown, FrameRead:
		if err := only("ids"); err != nil {
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
	case FrameClose:
		if err := only(); err != nil {
			return Frame{}, err
		}
	default:
		return Frame{}, fmt.Errorf("%w: type %q", ErrFrame, f.T)
	}
	return f, nil
}

// CheckFromHost is the window's rule for what the host may say. The window
// draws nothing that has not passed it.
func CheckFromHost(f Frame) (Frame, error) {
	switch f.T {
	case FrameHeader:
		f.Business, f.Technician = CleanName(f.Business), CleanName(f.Technician)
		if f.Business == "" || f.Technician == "" {
			return Frame{}, fmt.Errorf("%w: header without names", ErrFrame)
		}
	case FrameMsg:
		if !ValidID(f.ID) || (f.From != "technician" && f.From != "user") {
			return Frame{}, fmt.Errorf("%w: bad message", ErrFrame)
		}
		t, err := CleanText(f.Text)
		if err != nil {
			return Frame{}, err
		}
		f.Text, f.Name = t, CleanName(f.Name)
	case FrameSent:
		if !ValidCID(f.CID) || !ValidID(f.ID) {
			return Frame{}, fmt.Errorf("%w: bad sent", ErrFrame)
		}
	case FrameFailed, FrameEnd, FrameStatus:
		if f.T == FrameFailed && !ValidCID(f.CID) {
			return Frame{}, fmt.Errorf("%w: bad failed", ErrFrame)
		}
		f.Reason, f.Text = CleanName(f.Reason), CleanLine(f.Text, 200)
	default:
		return Frame{}, fmt.Errorf("%w: type %q", ErrFrame, f.T)
	}
	return f, nil
}
