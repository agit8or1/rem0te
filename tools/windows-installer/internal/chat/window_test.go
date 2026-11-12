package chat

import (
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// pipePair is the two pipes as the host sees them: it reads `up`, writes `down`.
type pipePair struct {
	upR, downR *io.PipeReader
	upW, downW *io.PipeWriter
	closed     atomic.Int32
}

func newPipes() *pipePair {
	p := &pipePair{}
	p.upR, p.upW = io.Pipe()
	p.downR, p.downW = io.Pipe()
	return p
}

func (p *pipePair) closeAll() error {
	p.closed.Add(1)
	p.upR.Close()
	p.downW.Close()
	return nil
}

func TestAttachNeedsTheNonce(t *testing.T) {
	nonce := NewNonce()
	cases := map[string]Frame{
		"wrong nonce":          {T: FrameHello, Nonce: NewNonce()},
		"a send before hello":  {T: FrameSend, CID: NewCID(), Text: "hi"},
		"a close before hello": {T: FrameClose},
	}
	for name, first := range cases {
		p := newPipes()
		go func() { _ = WriteFrame(p.upW, first) }()
		if _, err := Attach(p.upR, p.downW, p.closeAll, nonce, time.Second, nil); err == nil {
			t.Errorf("%s: attached", name)
		}
		if p.closed.Load() == 0 {
			t.Errorf("%s: the window's pipes must be closed", name)
		}
	}
	p := newPipes()
	start := time.Now()
	if _, err := Attach(p.upR, p.downW, p.closeAll, nonce, 100*time.Millisecond, nil); err == nil || time.Since(start) > time.Second {
		t.Fatal("a silent window must time out")
	}
}

func TestAttachedWindow(t *testing.T) {
	nonce := NewNonce()
	p := newPipes()
	go func() { _ = WriteFrame(p.upW, Frame{T: FrameHello, Nonce: nonce}) }()
	w, err := Attach(p.upR, p.downW, p.closeAll, nonce, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Host → window.
	go func() { _ = w.Send(Frame{T: FrameStatus, Text: "hello"}) }()
	f, err := NewReader(p.downR).Next()
	if err != nil || f.T != FrameStatus {
		t.Fatalf("%+v %v", f, err)
	}
	// Window → host: checked frames come through, cleaned.
	go func() { _ = WriteFrame(p.upW, Frame{T: FrameSend, CID: "abcdefgh12", Text: " hi\r\n "}) }()
	got := <-w.Frames()
	if got.T != FrameSend || got.Text != "hi" {
		t.Fatalf("%+v", got)
	}
	// A refused frame ends the window: the channel closes and the pipes go.
	go func() { _ = WriteFrame(p.upW, Frame{T: FrameHello, Nonce: nonce}) }()
	if _, ok := <-w.Frames(); ok {
		t.Fatal("a second hello must end the window")
	}
	if p.closed.Load() == 0 {
		t.Fatal("pipes not closed")
	}
}

func TestTranscript(t *testing.T) {
	tr := NewTranscript()
	tr.Location = time.UTC
	tr.Now = func() time.Time { return time.Date(2026, 11, 12, 10, 5, 0, 0, time.UTC) }
	if tr.Title() != "Support chat" || !strings.Contains(tr.Banner(), "Connecting") {
		t.Fatal("before the header the window must not claim to be anyone")
	}
	tr.Apply(Frame{T: FrameHeader, Business: "Acme Dental", Technician: "Jane Doe"})
	if tr.Title() != "Support chat - Acme Dental" || !strings.HasPrefix(tr.Banner(), "Jane Doe from Acme Dental support") || !strings.Contains(tr.Banner(), "never ask for your password") {
		t.Fatalf("title %q banner %q", tr.Title(), tr.Banner())
	}
	m := Frame{T: FrameMsg, ID: "ctech00000000000000000001", From: "technician", Name: "Jane Doe", Text: "line one\nline two", At: "2026-11-12T10:00:00Z"}
	if !tr.Apply(m) || tr.Apply(m) {
		t.Fatal("a message is added once, and a re-send is ignored")
	}
	if s, r := tr.Acks(false, false); s != nil || r != nil {
		t.Fatal("a minimised window has shown nothing")
	}
	s, r := tr.Acks(true, false)
	if len(s) != 1 || len(r) != 0 {
		t.Fatalf("visible, not in front: shown %v read %v", s, r)
	}
	s, r = tr.Acks(true, true)
	if len(s) != 0 || len(r) != 1 {
		t.Fatalf("each receipt once: shown %v read %v", s, r)
	}
	tr.Local("cidlocal0001", "my reply")
	if !strings.Contains(tr.Render(), "(sending...)") {
		t.Fatal("a reply is shown as sending until the host confirms it")
	}
	tr.Apply(Frame{T: FrameSent, CID: "cidlocal0001", ID: "cuserreply000000000000001"})
	if strings.Contains(tr.Render(), "sending") {
		t.Fatal("confirmed reply still sending")
	}
	tr.Local("cidlocal0002", "another")
	tr.Apply(Frame{T: FrameFailed, CID: "cidlocal0002", Reason: "Too many messages."})
	out := tr.Render()
	if !strings.Contains(out, "(Too many messages.)") {
		t.Fatalf("failure not shown: %q", out)
	}
	if !strings.Contains(out, "Jane Doe  10:00\r\n    line one\r\n    line two\r\n") || strings.Contains(strings.ReplaceAll(out, "\r\n", ""), "\n") {
		t.Fatalf("render must be CRLF text: %q", out)
	}
	tr.Apply(Frame{T: FrameEnd, Reason: "technician"})
	if !tr.Ended || !strings.Contains(tr.EndText(), "technician ended") {
		t.Fatal("end")
	}
	for i := 0; i < MaxLines+20; i++ {
		tr.Local(NewCID(), "x")
	}
	if len(tr.lines) != MaxLines {
		t.Fatalf("%d lines kept", len(tr.lines))
	}
}
