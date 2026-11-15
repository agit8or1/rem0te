package tray

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"
)

func TestHostExitRelaunch(t *testing.T) {
	if !HostExitReplaced.Relaunch() || !HostExitLifetime.Relaunch() || HostExitDone.Relaunch() {
		t.Fatal("a replaced or expired host must start its successor; a host that failed must not")
	}
}

// A tool reply of sixty full lines of multi-byte text was over the 16 KB
// frame: the host's send failed silently and the tray waited three minutes.
// FitReply trims it so it is sent, and the tray accepts it.
func TestLongestToolReplyFitsAFrame(t *testing.T) {
	lines := make([]string, 80)
	for i := range lines {
		lines[i] = string(bytes.Repeat([]byte("é"), 400))
	}
	r := res(OutcomeSucceeded, string(bytes.Repeat([]byte("é"), 600)), lines...)
	f := FitReply(Frame{T: FrameReply, ID: "0123456789abcdef", OK: true, Outcome: r.Outcome, Summary: r.Summary, Lines: r.Lines})
	if len(f.Lines) == 0 || f.Lines[len(f.Lines)-1] != TrimmedNote {
		t.Fatalf("not trimmed with a note: %d lines", len(f.Lines))
	}
	var buf bytes.Buffer
	if err := WriteFrame(&buf, f); err != nil {
		t.Fatalf("the host could not send its reply: %v", err)
	}
	got, err := NewReader(&buf).Next()
	if err != nil {
		t.Fatalf("the tray refused the reply: %v", err)
	}
	if _, err := CheckFromHost(got); err != nil {
		t.Fatalf("CheckFromHost: %v", err)
	}
}

// The tray backend survives a tool result: after a reply the tray is still
// attached (Gone is not closed) and the next state still arrives.
func TestPipeBackendSurvivesAToolReply(t *testing.T) {
	hostR, trayW := io.Pipe()
	trayR, hostW := io.Pipe()
	nonce := NewNonce()
	// The host side, started first (the pipes are synchronous): read the
	// hello, then answer one selfhelp request and send a state.
	hr := NewReader(hostR)
	go func() {
		if _, err := hr.Next(); err != nil { // hello
			return
		}
		req, err := hr.Next()
		if err != nil {
			return
		}
		_ = WriteFrame(hostW, Frame{T: FrameReply, ID: req.ID, OK: true, Outcome: OutcomeSucceeded, Summary: "This computer can reach your IT provider.", Lines: []string{"Gateway 192.0.2.1 (Ethernet): answered in 1 ms"}})
		_ = WriteFrame(hostW, Frame{T: FrameState, State: &State{Business: "Acme"}})
	}()
	b, err := NewPipeBackend(trayR, trayW, nonce, func() { trayR.Close(); trayW.Close() })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close(); hostR.Close(); hostW.Close() })
	states := make(chan State, 2)
	b.Start(func(s State) { states <- s })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := b.SelfHelp(ctx, "net.test")
	if err != nil || r.Outcome != OutcomeSucceeded {
		t.Fatalf("selfhelp: %+v %v", r, err)
	}
	select {
	case s := <-states:
		if s.Business != "Acme" {
			t.Fatalf("state %+v", s)
		}
	case <-ctx.Done():
		t.Fatal("no state after the reply")
	}
	select {
	case <-b.Gone():
		t.Fatal("the tray let go of the host after a tool result")
	default:
	}
}
