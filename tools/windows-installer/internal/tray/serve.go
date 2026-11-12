package tray

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// NewNonce is a per-launch tray nonce: 32 random bytes, hex.
func NewNonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func newReqID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Session is the person a tray runs for. User is the Windows account as the
// host read it from the session's token — never what the tray says.
type Session struct {
	ID      uint32
	User    string
	Console bool
}

// ErrNoUser: nobody is signed in where a tray could run.
var ErrNoUser = errors.New("no interactive user")

// Attach waits for the tray's hello and checks its nonce. The caller closes
// the pipes on timeout, which unblocks the read.
func Attach(r *Reader, nonce string) error {
	f, err := r.Next()
	if err != nil {
		return err
	}
	f, err = CheckFromTray(f)
	if err != nil {
		return err
	}
	if f.T != FrameHello || subtle.ConstantTimeCompare([]byte(f.Nonce), []byte(nonce)) != 1 {
		return fmt.Errorf("%w: the first frame was not this launch's hello", ErrFrame)
	}
	return nil
}

// Serve is the signed tray host's side of one session's tray, after Attach:
// it sends the state as it changes, and answers the tray's requests through
// Core with the session's user as the host read it. It returns when the tray
// disconnects, sends anything CheckFromTray refuses, or ctx ends.
func Serve(ctx context.Context, c *Core, s Session, r *Reader, w io.Writer, kick <-chan struct{}) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wmu sync.Mutex
	send := func(f Frame) error {
		wmu.Lock()
		defer wmu.Unlock()
		return WriteFrame(w, f)
	}
	frames := make(chan Frame)
	readErr := make(chan error, 1)
	go func() {
		for {
			f, err := r.Next()
			if err == nil {
				f, err = CheckFromTray(f)
			}
			if err == nil && f.T == FrameHello {
				err = fmt.Errorf("%w: a second hello", ErrFrame)
			}
			if err != nil {
				readErr <- err
				return
			}
			select {
			case frames <- f:
			case <-ctx.Done():
				return
			}
		}
	}()

	var last []byte
	pushState := func() time.Duration {
		st, poll, err := c.Refresh(ctx, s.User, s.Console)
		if err != nil {
			c.logf("tray: status for session %d: %v", s.ID, err)
		} else {
			c.FlushPending(ctx)
		}
		b, _ := json.Marshal(st)
		if !bytes.Equal(b, last) {
			if err := send(Frame{T: FrameState, State: &st}); err != nil {
				cancel()
			}
			last = b
		}
		return poll
	}
	timer := time.NewTimer(pushState())
	defer timer.Stop()

	// One request of each kind at a time: a second while one runs is refused.
	busy := map[string]bool{}
	var bmu sync.Mutex
	handle := func(f Frame) {
		bmu.Lock()
		if busy[f.T] {
			bmu.Unlock()
			_ = send(Frame{T: FrameReply, ID: f.ID, Reason: "Still working on the last one."})
			return
		}
		busy[f.T] = true
		bmu.Unlock()
		go func() {
			defer func() { bmu.Lock(); delete(busy, f.T); bmu.Unlock() }()
			_ = send(Answer(ctx, c, s.User, f))
		}()
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErr:
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		case <-kick:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(pushState())
		case <-timer.C:
			timer.Reset(pushState())
		case f := <-frames:
			if f.T == FrameSeen {
				c.Seen(f.IDs)
				continue
			}
			handle(f)
		}
	}
}

// Answer is the reply to one request frame (already through CheckFromTray).
func Answer(ctx context.Context, c *Core, user string, f Frame) Frame {
	rep := Frame{T: FrameReply, ID: f.ID}
	switch f.T {
	case FrameCode:
		u, err := c.OpenChat(ctx, user)
		if err != nil {
			rep.Reason = reason(err, "The chat could not be opened")
			return rep
		}
		rep.OK, rep.URL = true, u
	case FrameSupport:
		var shot []byte
		if f.Shot != "" {
			b, err := base64.StdEncoding.DecodeString(f.Shot)
			if err != nil {
				rep.Reason = "The screenshot could not be read."
				return rep
			}
			shot = b
		}
		if _, err := c.Support(ctx, user, f.Text, f.Usage, shot); err != nil {
			rep.Reason = reason(err, "The request could not be sent")
			return rep
		}
		rep.OK = true
	case FrameSelfHelp:
		r := c.SelfHelp(ctx, user, f.Tool)
		rep.OK, rep.Outcome, rep.Summary, rep.Lines = r.Outcome == OutcomeSucceeded, r.Outcome, r.Summary, r.Lines
	default:
		rep.Reason = "Unknown request."
	}
	return rep
}

// reason is what the person is told: the portal's own message for a
// refusal, a fixed sentence when the portal could not be reached.
func reason(err error, what string) string {
	var ae *APIError
	if errors.As(err, &ae) && ae.Message != "" {
		return ae.Message
	}
	if errors.Is(err, ErrLimited) || errors.Is(err, ErrRequestText) {
		return err.Error()
	}
	if Unreachable(err) {
		return what + ": your IT provider's portal could not be reached. Check the network and try again."
	}
	return what + "."
}
