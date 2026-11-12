package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const secret = "device-secret-0123456789abcdef"

// fakePortal is the two device routes, enough of them to drive the host: one
// conversation, technician messages with delivered/shown/read, replies.
type fakePortal struct {
	mu        sync.Mutex
	t         *testing.T
	open      bool
	noConv    bool
	ended     string
	msgs      []Message
	delivered map[string]bool
	shown     map[string]bool
	read      map[string]bool
	states    []string
	users     []string
	replies   []map[string]any
	polls     int
	histories int
	status    int // forced HTTP status for every request
	wake      chan struct{}
}

func newPortal(t *testing.T) *fakePortal {
	return &fakePortal{t: t, open: true, delivered: map[string]bool{}, shown: map[string]bool{}, read: map[string]bool{}, wake: make(chan struct{}, 16)}
}

func (p *fakePortal) techSays(id, text string) {
	p.mu.Lock()
	p.msgs = append(p.msgs, Message{ID: id, From: "technician", Name: "Jane Doe", Text: text, At: "2026-11-12T10:00:00Z"})
	p.mu.Unlock()
	p.wake <- struct{}{}
}

func (p *fakePortal) end(reason string) {
	p.mu.Lock()
	p.open, p.ended = false, reason
	p.mu.Unlock()
	p.wake <- struct{}{}
}

func (p *fakePortal) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	p.mu.Lock()
	forced := p.status
	p.mu.Unlock()
	if forced != 0 {
		w.WriteHeader(forced)
		return
	}
	if body["agentSecret"] != secret || body["rustdeskId"] != "123456789" {
		w.WriteHeader(401)
		return
	}
	ids := func(k string) []string {
		var out []string
		if a, ok := body[k].([]any); ok {
			for _, x := range a {
				out = append(out, x.(string))
			}
		}
		return out
	}
	reply := func(v any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": v})
	}
	switch r.URL.Path {
	case "/api/v1/enrollment/chat/reply":
		p.mu.Lock()
		p.replies = append(p.replies, body)
		n := len(p.replies)
		p.mu.Unlock()
		reply(map[string]any{"id": fmt.Sprintf("cuserreply%015d", n), "duplicate": false})
	case "/api/v1/enrollment/chat/poll":
		p.mu.Lock()
		p.polls++
		for _, id := range ids("delivered") {
			p.delivered[id] = true
		}
		for _, id := range ids("shown") {
			p.shown[id] = true
		}
		for _, id := range ids("read") {
			p.read[id] = true
		}
		if s, _ := body["state"].(string); s != "" && (len(p.states) == 0 || p.states[len(p.states)-1] != s) {
			p.states = append(p.states, s)
		}
		if u, _ := body["userName"].(string); u != "" {
			p.users = append(p.users, u)
		}
		if body["state"] == "user_closed" {
			p.open, p.ended = false, "end_user"
		}
		build := func() map[string]any {
			if p.noConv {
				return map[string]any{"conversation": nil, "messages": []Message{}}
			}
			status := "OPEN"
			if !p.open {
				status = "ENDED"
			}
			conv := map[string]any{"id": "cconversation000000000001", "status": status, "businessName": "Acme Dental", "technicianName": "Jane Doe", "endedReason": p.ended}
			var out []Message
			if body["history"] == true {
				p.histories++
				out = append(out, p.msgs...)
				out = append(out, Message{ID: "cuserearlier00000000000001", From: "user", Name: `ACME\alice`, Text: "earlier reply", At: "2026-11-12T09:59:00Z"})
			} else if p.open {
				for _, m := range p.msgs {
					if !p.delivered[m.ID] {
						out = append(out, m)
					}
				}
			}
			return map[string]any{"conversation": conv, "messages": out}
		}
		resp := build()
		idle := p.open && len(resp["messages"].([]Message)) == 0 && body["noWait"] != true && body["history"] != true
		p.mu.Unlock()
		if idle {
			select {
			case <-p.wake:
			case <-time.After(300 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
			p.mu.Lock()
			resp = build()
			p.mu.Unlock()
		}
		reply(resp)
	default:
		w.WriteHeader(404)
	}
}

// fakeWindow stands in for the Win32 window: the test reads what the host
// sent it and plays the person's part.
type fakeWindow struct {
	got    chan Frame
	frames chan Frame
	closed chan struct{}
	once   sync.Once
}

func (w *fakeWindow) Send(f Frame) error {
	select {
	case <-w.closed:
		return io.ErrClosedPipe
	default:
	}
	w.got <- f
	return nil
}
func (w *fakeWindow) Frames() <-chan Frame { return w.frames }
func (w *fakeWindow) Close() error         { w.once.Do(func() { close(w.closed) }); return nil }

type fakeDesk struct {
	mu       sync.Mutex
	user     string
	opens    int
	windows  chan *fakeWindow
	failOpen error
}

func (d *fakeDesk) ActiveUser() (Session, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.user == "" {
		return Session{}, ErrNoUser
	}
	return Session{ID: 1, User: d.user}, nil
}
func (d *fakeDesk) Open(ctx context.Context, s Session) (Window, error) {
	d.mu.Lock()
	d.opens++
	fail := d.failOpen
	d.mu.Unlock()
	if fail != nil {
		return nil, fail
	}
	w := &fakeWindow{got: make(chan Frame, 64), frames: make(chan Frame, 16), closed: make(chan struct{})}
	d.windows <- w
	return w, nil
}

func setup(t *testing.T) (*fakePortal, *fakeDesk, *Host, func()) {
	p := newPortal(t)
	srv := httptest.NewServer(p)
	d := &fakeDesk{user: `ACME\alice`, windows: make(chan *fakeWindow, 4)}
	h := &Host{API: &Client{Base: srv.URL + "/api/v1", RustdeskID: "123456789", Secret: secret, HTTP: srv.Client()}, Desk: d,
		Logf: t.Logf, NoWindowEvery: 50 * time.Millisecond, RetryMin: 20 * time.Millisecond, RetryMax: 50 * time.Millisecond, MaxLifetime: 10 * time.Second}
	return p, d, h, srv.Close
}

func next(t *testing.T, w *fakeWindow, typ string) Frame {
	t.Helper()
	for {
		select {
		case f := <-w.got:
			if f.T == typ {
				return f
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("window never got a %s frame", typ)
		}
	}
}

func run(h *Host) chan [2]any {
	done := make(chan [2]any, 1)
	go func() { o, err := h.Run(context.Background()); done <- [2]any{o, err} }()
	return done
}

func wait(t *testing.T, done chan [2]any) (Outcome, error) {
	t.Helper()
	select {
	case r := <-done:
		err, _ := r[1].(error)
		return r[0].(Outcome), err
	case <-time.After(5 * time.Second):
		t.Fatal("host did not finish")
	}
	return "", nil
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("never: %s", what)
}

func TestHostNothingOpen(t *testing.T) {
	p, _, h, stop := setup(t)
	defer stop()
	p.noConv = true
	o, err := h.Run(context.Background())
	if o != OutcomeNoChat || err != nil {
		t.Fatalf("%s %v", o, err)
	}
}

func TestHostUnauthorized(t *testing.T) {
	_, _, h, stop := setup(t)
	defer stop()
	h.API.Secret = "wrong-secret-0123456789"
	if _, err := h.Run(context.Background()); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized, got %v", err)
	}
}

func TestHostConversation(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	p.msgs = []Message{{ID: "ctech00000000000000000001", From: "technician", Name: "Jane Doe", Text: "Hi, it's Jane from IT", At: "2026-11-12T10:00:00Z"}}
	done := run(h)
	w := <-d.windows

	hdr := next(t, w, FrameHeader)
	if hdr.Business != "Acme Dental" || hdr.Technician != "Jane Doe" {
		t.Fatalf("header %+v", hdr)
	}
	m := next(t, w, FrameMsg)
	if m.ID != "ctech00000000000000000001" {
		t.Fatalf("first message %+v", m)
	}
	next(t, w, FrameMsg) // the earlier reply, from the history
	eventually(t, "delivered acknowledged", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.delivered["ctech00000000000000000001"] })
	p.mu.Lock()
	if p.shown["ctech00000000000000000001"] || p.read["ctech00000000000000000001"] {
		t.Fatal("shown/read must wait for the window to say so")
	}
	if len(p.users) == 0 || p.users[len(p.users)-1] != `ACME\alice` {
		t.Fatalf("user name not reported: %v", p.users)
	}
	p.mu.Unlock()

	w.frames <- Frame{T: FrameShown, IDs: []string{"ctech00000000000000000001"}}
	eventually(t, "shown acknowledged", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.shown["ctech00000000000000000001"] })
	w.frames <- Frame{T: FrameRead, IDs: []string{"ctech00000000000000000001"}}
	eventually(t, "read acknowledged", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.read["ctech00000000000000000001"] })

	cid := NewCID()
	w.frames <- Frame{T: FrameSend, CID: cid, Text: "the printer says offline"}
	sent := next(t, w, FrameSent)
	if sent.CID != cid || !ValidID(sent.ID) {
		t.Fatalf("sent %+v", sent)
	}
	p.mu.Lock()
	if len(p.replies) != 1 || p.replies[0]["clientId"] != cid || p.replies[0]["text"] != "the printer says offline" || p.replies[0]["conversationId"] != "cconversation000000000001" {
		t.Fatalf("reply %+v", p.replies)
	}
	p.mu.Unlock()

	// A new technician message wakes the held poll and reaches the window.
	p.techSays("ctech00000000000000000002", "Try turning it off and on")
	if f := next(t, w, FrameMsg); f.ID != "ctech00000000000000000002" {
		t.Fatalf("second message %+v", f)
	}

	p.end("technician")
	if f := next(t, w, FrameEnd); f.Reason != "technician" {
		t.Fatalf("end %+v", f)
	}
	o, err := wait(t, done)
	if o != OutcomeEnded || err != nil {
		t.Fatalf("%s %v", o, err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.histories != 1 {
		t.Errorf("history asked %d times, want once (on open)", p.histories)
	}
	if strings.Join(p.states, ",") != "connecting,window_open" {
		t.Errorf("states %v", p.states)
	}
}

func TestHostNeverHandsTheSecretToTheWindow(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	p.msgs = []Message{{ID: "ctech00000000000000000001", From: "technician", Name: "Jane", Text: "hi", At: "x"}}
	done := run(h)
	w := <-d.windows
	next(t, w, FrameMsg)
	p.end("technician")
	next(t, w, FrameEnd)
	wait(t, done)
	close(w.got)
	for f := range w.got {
		b, _ := json.Marshal(f)
		if strings.Contains(string(b), secret) || strings.Contains(string(b), "123456789") {
			t.Fatalf("frame to the window carries the device identity: %s", b)
		}
	}
}

func TestHostNoUserThenSignIn(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	d.user = ""
	done := run(h)
	eventually(t, "no_user reported", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.states) > 0 && p.states[len(p.states)-1] == "no_user"
	})
	d.mu.Lock()
	if d.opens != 0 {
		t.Fatal("no window may be opened without a user")
	}
	d.mu.Unlock()
	p.techSays("ctech00000000000000000003", "are you there?")
	// Delivered to the agent even with nobody signed in — and only delivered.
	eventually(t, "delivered while nobody is signed in", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.delivered["ctech00000000000000000003"] })
	p.mu.Lock()
	if p.shown["ctech00000000000000000003"] {
		t.Fatal("nothing is shown with nobody signed in")
	}
	p.mu.Unlock()
	d.mu.Lock()
	d.user = `ACME\bob`
	d.mu.Unlock()
	w := <-d.windows
	next(t, w, FrameHeader)
	if f := next(t, w, FrameMsg); f.ID != "ctech00000000000000000003" {
		t.Fatalf("the window must start with the transcript: %+v", f)
	}
	p.end("technician")
	wait(t, done)
	p.mu.Lock()
	defer p.mu.Unlock()
	if strings.Join(p.states, ",") != "connecting,no_user,window_open" {
		t.Errorf("states %v", p.states)
	}
}

func TestHostUserCloses(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	done := run(h)
	w := <-d.windows
	next(t, w, FrameHeader)
	w.frames <- Frame{T: FrameClose}
	o, err := wait(t, done)
	if o != OutcomeUserClosed || err != nil {
		t.Fatalf("%s %v", o, err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.states[len(p.states)-1] != "user_closed" {
		t.Fatalf("user_closed not reported: %v", p.states)
	}
}

func TestHostReopensAWindowThatDisappears(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	done := run(h)
	w := <-d.windows
	next(t, w, FrameHeader)
	close(w.frames) // the window died without saying close (sign-out, crash)
	w2 := <-d.windows
	next(t, w2, FrameHeader)
	p.end("inactive")
	if f := next(t, w2, FrameEnd); f.Reason != "inactive" {
		t.Fatalf("%+v", f)
	}
	if o, _ := wait(t, done); o != OutcomeEnded {
		t.Fatalf("outcome %s", o)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.opens != 2 {
		t.Fatalf("opened %d windows, want 2", d.opens)
	}
}

func TestHostWindowFailure(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	d.failOpen = errors.New("CreateProcessAsUser: Access is denied.")
	done := run(h)
	eventually(t, "window_failed reported", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.states) > 0 && p.states[len(p.states)-1] == "window_failed"
	})
	p.end("technician")
	if o, _ := wait(t, done); o != OutcomeEnded {
		t.Fatalf("outcome %s", o)
	}
}

func TestHostLocalRateLimit(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	h.Limit = NewLimiter(2, time.Minute)
	done := run(h)
	w := <-d.windows
	next(t, w, FrameHeader)
	for i := 0; i < 3; i++ {
		w.frames <- Frame{T: FrameSend, CID: fmt.Sprintf("cid0000000%d", i), Text: "spam"}
	}
	next(t, w, FrameSent)
	next(t, w, FrameSent)
	f := next(t, w, FrameFailed)
	if f.CID != "cid00000002" || !strings.Contains(f.Reason, "Too many") {
		t.Fatalf("third reply %+v", f)
	}
	p.mu.Lock()
	n := len(p.replies)
	p.mu.Unlock()
	if n != 2 {
		t.Fatalf("%d replies reached the portal, want 2", n)
	}
	p.end("technician")
	wait(t, done)
}

func TestHostRefusedReplyIsReported(t *testing.T) {
	p, d, h, stop := setup(t)
	defer stop()
	done := run(h)
	w := <-d.windows
	next(t, w, FrameHeader)
	next(t, w, FrameMsg) // the history has arrived
	p.mu.Lock()
	p.status = 429
	p.mu.Unlock()
	w.frames <- Frame{T: FrameSend, CID: NewCID(), Text: "hello?"}
	f := next(t, w, FrameFailed)
	if f.Reason == "" {
		t.Fatal("a refused reply must say so in the window")
	}
	p.mu.Lock()
	p.status = 0
	p.mu.Unlock()
	p.end("technician")
	wait(t, done)
}
