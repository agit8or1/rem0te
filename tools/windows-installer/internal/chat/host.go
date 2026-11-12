package chat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// Session is the console session someone is signed in to.
type Session struct {
	ID   uint32
	User string // DOMAIN\name, as Windows reports the session's token
}

// ErrNoUser: nobody is signed in at the console, so there is no desktop to
// draw on. Reported to the portal as the state no_user — never as "sent".
var ErrNoUser = errors.New("nobody is signed in at the console")

// Desktop is what the host needs from Windows. chat_windows.go implements it
// with WTSQueryUserToken / CreateProcessAsUser and two named pipes; tests fake it.
type Desktop interface {
	ActiveUser() (Session, error)
	// Open starts the window in s and returns it once it has said hello with
	// the right nonce (see Attach).
	Open(ctx context.Context, s Session) (Window, error)
}

// Window is an attached chat window.
type Window interface {
	Send(Frame) error
	// Frames yields frames that passed CheckFromWindow. It is closed when the
	// window goes away (process exit, broken pipe, a refused frame).
	Frames() <-chan Frame
	Close() error
}

// ── The pipe window ──────────────────────────────────────────────────────────

// PipeWindow is a Window over two one-way streams.
type PipeWindow struct {
	w      io.Writer
	closer func() error
	frames chan Frame
	mu     sync.Mutex
	once   sync.Once
	Logf   func(string, ...any)
}

// NewNonce is the per-launch secret the window must echo in its hello. It
// is passed on the window's command line, so it proves only "this is the
// process we started" — it is not a credential for anything else, and it is
// never sent to the portal.
func NewNonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// NewCID is a client id for one reply.
func NewCID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// Attach waits for the window's hello on r (at most timeout) and checks its
// nonce. Anything else first — another frame, a wrong nonce, silence — ends
// the window: closeAll is called and an error returned.
func Attach(r io.Reader, w io.Writer, closeAll func() error, nonce string, timeout time.Duration, logf func(string, ...any)) (*PipeWindow, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	fr := NewReader(r)
	type hello struct {
		f   Frame
		err error
	}
	got := make(chan hello, 1)
	go func() { f, err := fr.Next(); got <- hello{f, err} }()
	var h hello
	select {
	case h = <-got:
	case <-time.After(timeout):
		_ = closeAll()
		return nil, errors.New("the chat window did not say hello in time")
	}
	if h.err == nil {
		h.f, h.err = CheckFromWindow(h.f)
	}
	if h.err != nil || h.f.T != FrameHello || h.f.Nonce != nonce {
		_ = closeAll()
		if h.err == nil {
			h.err = errors.New("the chat window's hello did not carry this launch's nonce")
		}
		return nil, h.err
	}
	pw := &PipeWindow{w: w, closer: closeAll, frames: make(chan Frame, 32), Logf: logf}
	go func() {
		defer close(pw.frames)
		for {
			f, err := fr.Next()
			if err != nil {
				if !errors.Is(err, io.EOF) {
					logf("chat window: %v", err)
				}
				_ = pw.Close()
				return
			}
			f, err = CheckFromWindow(f)
			if err != nil || f.T == FrameHello {
				logf("chat window sent a refused frame; closing it: %v", err)
				_ = pw.Close()
				return
			}
			pw.frames <- f
		}
	}()
	return pw, nil
}

func (p *PipeWindow) Send(f Frame) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return WriteFrame(p.w, f)
}
func (p *PipeWindow) Frames() <-chan Frame { return p.frames }
func (p *PipeWindow) Close() error {
	var err error
	p.once.Do(func() { err = p.closer() })
	return err
}

// ── The host ─────────────────────────────────────────────────────────────────

// Host runs one conversation: from the heartbeat saying a chat is open until
// the portal says it ended, the person closes the window, or MaxLifetime.
type Host struct {
	API         *Client
	Desk        Desktop
	Logf        func(string, ...any)
	MaxLifetime time.Duration // default 12 h
	// Waits between polls when there is no window (nobody signed in, or the
	// window could not be opened), and after a failed request.
	NoWindowEvery time.Duration // default 15 s
	RetryMin      time.Duration // default 2 s
	RetryMax      time.Duration // default 60 s
	Limit         *Limiter      // default 20 a minute, as the portal
}

// Outcome says why Run returned.
type Outcome string

const (
	OutcomeNoChat     Outcome = "no_chat"     // nothing open when the host started
	OutcomeEnded      Outcome = "ended"       // the portal ended it (technician, inactivity)
	OutcomeUserClosed Outcome = "user_closed" // the person closed the window
	OutcomeLifetime   Outcome = "lifetime"
	OutcomeCanceled   Outcome = "canceled"
)

func (h *Host) logf(f string, a ...any) {
	if h.Logf != nil {
		h.Logf(f, a...)
	}
}

func (h *Host) defaults() {
	if h.MaxLifetime == 0 {
		h.MaxLifetime = 12 * time.Hour
	}
	if h.NoWindowEvery == 0 {
		h.NoWindowEvery = 15 * time.Second
	}
	if h.RetryMin == 0 {
		h.RetryMin = 2 * time.Second
	}
	if h.RetryMax == 0 {
		h.RetryMax = 60 * time.Second
	}
	if h.Limit == nil {
		h.Limit = NewLimiter(20, time.Minute)
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

type pollResult struct {
	r   PollResponse
	err error
}

// hostState is what the next poll reports.
type hostState struct {
	conv      Conversation
	state     string
	detail    string
	user      string
	delivered []string
	shown     []string
	read      []string
	// A window was just opened and has not had the transcript yet.
	needHistory bool
}

func (s *hostState) request(noWait bool) PollRequest {
	return PollRequest{ConversationID: s.conv.ID, State: s.state, Detail: s.detail, UserName: s.user,
		Delivered: s.delivered, Shown: s.shown, Read: s.read, NoWait: noWait}
}

// sent clears the acknowledgements a successful poll carried.
func (s *hostState) sent(p PollRequest) {
	s.delivered = without(s.delivered, p.Delivered)
	s.shown = without(s.shown, p.Shown)
	s.read = without(s.read, p.Read)
}

func without(have, gone []string) []string {
	if len(gone) == 0 {
		return have
	}
	g := map[string]bool{}
	for _, x := range gone {
		g[x] = true
	}
	out := have[:0:0]
	for _, x := range have {
		if !g[x] {
			out = append(out, x)
		}
	}
	return out
}

func addIDs(have []string, more ...string) []string {
	seen := map[string]bool{}
	for _, x := range have {
		seen[x] = true
	}
	for _, x := range more {
		if ValidID(x) && !seen[x] {
			have = append(have, x)
			seen[x] = true
		}
	}
	if len(have) > 100 {
		have = have[len(have)-100:]
	}
	return have
}

func msgFrame(m Message) Frame {
	return Frame{T: FrameMsg, ID: m.ID, From: m.From, Name: m.Name, Text: m.Text, At: m.At}
}

// Run is the host's loop. It returns an error only when it cannot go on
// (the portal does not recognise the device); every other failure is retried.
func (h *Host) Run(ctx context.Context) (Outcome, error) {
	h.defaults()
	ctx, cancel := context.WithTimeout(ctx, h.MaxLifetime)
	defer cancel()

	st := &hostState{state: "connecting"}
	first, err := h.API.Poll(ctx, st.request(true))
	if err != nil {
		return OutcomeNoChat, err
	}
	if first.Conversation == nil || first.Conversation.Status != "OPEN" {
		return OutcomeNoChat, nil
	}
	st.conv = *first.Conversation
	for _, m := range first.Messages {
		if m.From == "technician" {
			st.delivered = addIDs(st.delivered, m.ID)
		}
	}

	var win Window
	defer func() {
		if win != nil {
			_ = win.Close()
		}
	}()
	backoff := h.RetryMin
	fail := func(err error) error {
		h.logf("chat: %v (retrying in %s)", err, backoff)
		if e := sleep(ctx, backoff); e != nil {
			return e
		}
		if backoff *= 2; backoff > h.RetryMax {
			backoff = h.RetryMax
		}
		return nil
	}

	for {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return OutcomeLifetime, nil
			}
			return OutcomeCanceled, nil
		}

		// No window yet (or it went away): find the signed-in user and open one.
		if win == nil {
			s, err := h.Desk.ActiveUser()
			switch {
			case errors.Is(err, ErrNoUser):
				st.state, st.detail, st.user = "no_user", "", ""
			case err != nil:
				st.state, st.detail = "window_failed", CleanLine(err.Error(), 200)
			default:
				w, oerr := h.openWindow(ctx, st, s)
				if errors.Is(oerr, ErrUnauthorized) {
					return OutcomeNoChat, oerr
				}
				if oerr != nil {
					st.state, st.detail, st.user = "window_failed", CleanLine(oerr.Error(), 200), CleanName(s.User)
					h.logf("chat: could not open the window for %s: %v", s.User, oerr)
				} else {
					win = w
				}
			}
		}
		if win != nil && st.needHistory {
			if err := h.loadHistory(ctx, st, win); err != nil {
				switch {
				case errors.Is(err, ErrUnauthorized):
					return OutcomeNoChat, err
				case errors.Is(err, errWindowGone):
					_ = win.Close()
					win = nil
				default:
					_ = fail(err)
				}
				continue
			}
		}

		// One poll, held by the portal while there is nothing new — unless the
		// window says something first, which cancels it (anything the canceled
		// poll returned was not acknowledged, so it comes back next time).
		req := st.request(win == nil)
		pctx, pcancel := context.WithCancel(ctx)
		done := make(chan pollResult, 1)
		go func() { r, err := h.API.Poll(pctx, req); done <- pollResult{r, err} }()

		var frames <-chan Frame
		if win != nil {
			frames = win.Frames()
		}
		select {
		case res := <-done:
			pcancel()
			if res.err != nil {
				if errors.Is(res.err, ErrUnauthorized) {
					return OutcomeNoChat, res.err
				}
				if e := fail(res.err); e != nil {
					continue
				}
				continue
			}
			backoff = h.RetryMin
			st.sent(req)
			c := res.r.Conversation
			if c == nil || c.ID != st.conv.ID || c.Status != "OPEN" {
				reason := "ended"
				if c != nil && c.EndedReason != "" {
					reason = c.EndedReason
				}
				if win != nil {
					_ = win.Send(Frame{T: FrameEnd, Reason: reason})
				}
				if c != nil && c.EndedReason == "end_user" {
					return OutcomeUserClosed, nil
				}
				return OutcomeEnded, nil
			}
			for _, m := range res.r.Messages {
				if m.From != "technician" {
					continue
				}
				st.delivered = addIDs(st.delivered, m.ID)
				if win != nil {
					if err := win.Send(msgFrame(m)); err != nil {
						_ = win.Close()
						win = nil
						break
					}
				}
			}
			if res.r.RetryAfterMs > 0 {
				_ = sleep(ctx, time.Duration(min(res.r.RetryAfterMs, 60_000))*time.Millisecond)
			} else if win == nil && len(res.r.Messages) == 0 {
				_ = sleep(ctx, h.NoWindowEvery)
			}

		case f, ok := <-frames:
			pcancel()
			<-done
			if !ok {
				// The window went away without saying close: the person signed
				// out, or it crashed. Open it again rather than end the chat.
				_ = win.Close()
				win = nil
				st.state, st.detail = "connecting", ""
				_ = sleep(ctx, 2*time.Second)
				continue
			}
			switch f.T {
			case FrameShown:
				st.shown = addIDs(st.shown, f.IDs...)
			case FrameRead:
				st.read = addIDs(st.read, f.IDs...)
			case FrameSend:
				h.reply(ctx, win, st.conv.ID, f)
			case FrameClose:
				st.state, st.detail = "user_closed", ""
				req := st.request(true)
				for i := 0; i < 3; i++ {
					if _, err := h.API.Poll(ctx, req); err == nil || errors.Is(err, ErrUnauthorized) {
						break
					}
					_ = sleep(ctx, h.RetryMin)
				}
				return OutcomeUserClosed, nil
			}

		case <-ctx.Done():
			pcancel()
			<-done
		}
	}
}

// openWindow starts the window in s and introduces the chat (business and
// technician). The transcript so far follows from loadHistory.
func (h *Host) openWindow(ctx context.Context, st *hostState, s Session) (Window, error) {
	w, err := h.Desk.Open(ctx, s)
	if err != nil {
		return nil, err
	}
	if err := w.Send(Frame{T: FrameHeader, Business: st.conv.BusinessName, Technician: st.conv.TechnicianName}); err != nil {
		_ = w.Close()
		return nil, err
	}
	st.state, st.detail, st.user = "window_open", "", CleanName(s.User)
	st.needHistory = true
	return w, nil
}

// loadHistory fills a newly opened window with the whole transcript, not just
// what is new. A network failure leaves the window open and is retried.
func (h *Host) loadHistory(ctx context.Context, st *hostState, w Window) error {
	req := st.request(true)
	req.History = true
	hr, err := h.API.Poll(ctx, req)
	if err != nil {
		return err
	}
	st.sent(req)
	st.needHistory = false
	for _, m := range hr.Messages {
		if m.From == "technician" {
			st.delivered = addIDs(st.delivered, m.ID)
		}
		if err := w.Send(msgFrame(m)); err != nil {
			return errWindowGone
		}
	}
	return nil
}

var errWindowGone = errors.New("the chat window went away")

// reply posts one message the window sent, retrying a network failure with
// the same client id, and tells the window whether it went.
func (h *Host) reply(ctx context.Context, win Window, convID string, f Frame) {
	if !h.Limit.Allow() {
		_ = win.Send(Frame{T: FrameFailed, CID: f.CID, Reason: "Too many messages. Wait a minute and try again."})
		return
	}
	var last error
	for i := 0; i < 3; i++ {
		rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		r, err := h.API.Reply(rctx, convID, f.CID, f.Text)
		cancel()
		if err == nil && ValidID(r.ID) {
			_ = win.Send(Frame{T: FrameSent, CID: f.CID, ID: r.ID})
			return
		}
		last = err
		var he *HTTPError
		if errors.Is(err, ErrUnauthorized) || errors.As(err, &he) {
			break // a refusal, not a network failure: retrying changes nothing
		}
		_ = sleep(ctx, h.RetryMin)
	}
	reason := "Not sent: the connection to your IT provider failed."
	var he *HTTPError
	if errors.As(last, &he) {
		switch he.Code {
		case "CHAT_RATE_LIMITED":
			reason = "Too many messages. Wait a minute and try again."
		case "CHAT_ENDED":
			reason = "Not sent: this chat has ended."
		case "CHAT_TOO_LONG":
			reason = "Not sent: a message can be at most 2,000 characters."
		default:
			reason = fmt.Sprintf("Not sent (refused: %d).", he.Status)
		}
	}
	h.logf("chat: reply %s not sent: %v", f.CID, last)
	_ = win.Send(Frame{T: FrameFailed, CID: f.CID, Reason: reason})
}
