//go:build !windows

package remote

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// fakePortal hands out queued answers and records every post.
type fakePortal struct {
	mu       sync.Mutex
	answers  chan PollAnswer
	posts    []OutputPost
	polls    [][]Held
	pollErr  error
	endOnOut bool
}

func newPortal() *fakePortal { return &fakePortal{answers: make(chan PollAnswer, 32)} }

func (f *fakePortal) Poll(ctx context.Context, held []Held, wait bool) (PollAnswer, error) {
	f.mu.Lock()
	f.polls = append(f.polls, append([]Held(nil), held...))
	err := f.pollErr
	f.mu.Unlock()
	if err != nil {
		time.Sleep(20 * time.Millisecond)
		return PollAnswer{}, err
	}
	select {
	case a := <-f.answers:
		return a, nil
	case <-ctx.Done():
		return PollAnswer{}, ctx.Err()
	case <-time.After(50 * time.Millisecond):
		return PollAnswer{EndpointID: "ep1"}, nil
	}
}

func (f *fakePortal) Output(_ context.Context, p OutputPost) (OutputReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.posts = append(f.posts, p)
	return OutputReply{End: f.endOnOut}, nil
}

func (f *fakePortal) snapshot() []OutputPost {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]OutputPost(nil), f.posts...)
}

func (f *fakePortal) output(id string) string {
	var b strings.Builder
	for _, p := range f.snapshot() {
		if p.SessionID != id {
			continue
		}
		for _, fr := range p.Frames {
			d, _ := base64.StdEncoding.DecodeString(fr.Data)
			b.Write(d)
		}
	}
	return b.String()
}

func (f *fakePortal) has(id string, pred func(OutputPost) bool) bool {
	for _, p := range f.snapshot() {
		if p.SessionID == id && pred(p) {
			return true
		}
	}
	return false
}

const sid1 = "0123456789abcdef0123456789abcdef"
const sid2 = "fedcba9876543210fedcba9876543210"

func shSpawner(t *testing.T) SystemSpawner {
	t.Helper()
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh")
	}
	return SystemSpawner{Shells: map[string][]string{"cmd": {"/bin/sh"}, "powershell": {"/bin/sh"}}}
}

func waitFor(t *testing.T, what string, d time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func start(id, shell string) PollAnswer {
	return PollAnswer{EndpointID: "ep1", Terminals: []Instruction{{ID: id, Op: "start", Shell: shell,
		NotAfter: time.Now().Add(time.Hour).Format(time.RFC3339Nano), IdleAt: time.Now().Add(15 * time.Minute).Format(time.RFC3339Nano)}}}
}

func input(id string, seq int, s string) PollAnswer {
	return PollAnswer{EndpointID: "ep1", Terminals: []Instruction{{ID: id, Op: "open",
		NotAfter: time.Now().Add(time.Hour).Format(time.RFC3339Nano), IdleAt: time.Now().Add(15 * time.Minute).Format(time.RFC3339Nano),
		Input: []InFrame{{Seq: seq, Data: base64.StdEncoding.EncodeToString([]byte(s))}}}}}
}

func run(t *testing.T, w *Worker) (context.CancelFunc, chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	return cancel, done
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestStartInputOutputExit(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute, FlushEvery: 20 * time.Millisecond}
	run(t, w)
	f.answers <- start(sid1, "cmd")
	waitFor(t, "started", 3*time.Second, func() bool { return f.has(sid1, func(p OutputPost) bool { return p.Started }) })
	f.answers <- input(sid1, 1, "echo hello-$((40+2))\n")
	waitFor(t, "output", 3*time.Second, func() bool { return strings.Contains(f.output(sid1), "hello-42") })
	f.answers <- input(sid1, 2, "echo oops 1>&2; exit 7\n")
	waitFor(t, "exit", 3*time.Second, func() bool {
		return f.has(sid1, func(p OutputPost) bool { return p.Exited != nil && p.Exited.Code == 7 })
	})
	// stderr arrived as its own stream, and sequence numbers follow on.
	seq, sawErr := 0, false
	for _, p := range f.snapshot() {
		for _, fr := range p.Frames {
			if fr.Seq != seq+1 {
				t.Fatalf("seq %d after %d", fr.Seq, seq)
			}
			seq = fr.Seq
			if fr.Stream == "stderr" {
				sawErr = true
			}
		}
	}
	if !sawErr {
		t.Fatal("no stderr frame")
	}
	waitFor(t, "removed", 2*time.Second, func() bool { return w.Live() == 0 })
}

func TestEndKillsTheWholeTree(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute, FlushEvery: 20 * time.Millisecond}
	run(t, w)
	f.answers <- start(sid1, "powershell")
	waitFor(t, "started", 3*time.Second, func() bool { return f.has(sid1, func(p OutputPost) bool { return p.Started }) })
	f.answers <- input(sid1, 1, "sleep 300 & echo child=$!\n")
	var pid int
	waitFor(t, "child pid", 3*time.Second, func() bool {
		out := f.output(sid1)
		i := strings.Index(out, "child=")
		if i < 0 {
			return false
		}
		n, err := strconv.Atoi(strings.TrimSpace(strings.SplitN(out[i+6:], "\n", 2)[0]))
		pid = n
		return err == nil && n > 0
	})
	if !alive(pid) {
		t.Fatal("the child is not running, so the tree kill is not tested")
	}
	f.answers <- PollAnswer{EndpointID: "ep1", Terminals: []Instruction{{ID: sid1, Op: "end", Reason: "revoked"}}}
	waitFor(t, "session gone", 3*time.Second, func() bool { return w.Live() == 0 })
	waitFor(t, "child killed", 3*time.Second, func() bool { return !alive(pid) || zombie(pid) })
}

// zombie: killed but not yet reaped by its (also killed) parent's parent.
func zombie(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	f := strings.Fields(string(b))
	return len(f) > 2 && f[2] == "Z"
}

func TestHardLimitHoldsWithoutThePortal(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute, MaxSession: 600 * time.Millisecond, Tick: 50 * time.Millisecond}
	run(t, w)
	// The portal asks for an hour; the worker's own limit wins.
	f.answers <- start(sid1, "cmd")
	waitFor(t, "started", 3*time.Second, func() bool { return w.Live() == 1 })
	waitFor(t, "expired", 3*time.Second, func() bool { return w.Live() == 0 })
}

func TestIdleLimitAndInputMovesIt(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute, IdleTimeout: 700 * time.Millisecond, Tick: 50 * time.Millisecond, FlushEvery: 20 * time.Millisecond}
	run(t, w)
	a := start(sid1, "cmd")
	a.Terminals[0].IdleAt = time.Now().Format(time.RFC3339Nano) // the portal's idle clock: already due
	f.answers <- a
	waitFor(t, "started", 3*time.Second, func() bool { return w.Live() == 1 })
	time.Sleep(400 * time.Millisecond)
	in := input(sid1, 1, "echo still-here\n") // input moves the idle clock
	in.Terminals[0].IdleAt = time.Now().Format(time.RFC3339Nano)
	f.answers <- in
	time.Sleep(500 * time.Millisecond)
	if w.Live() != 1 {
		t.Fatal("input did not move the idle clock")
	}
	waitFor(t, "idle expiry", 3*time.Second, func() bool { return w.Live() == 0 })
}

func TestDisconnectEndsEverything(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute, DisconnectKill: 300 * time.Millisecond}
	run(t, w)
	f.answers <- start(sid1, "cmd")
	waitFor(t, "started", 3*time.Second, func() bool { return w.Live() == 1 })
	f.mu.Lock()
	f.pollErr = errors.New("connection refused")
	f.mu.Unlock()
	waitFor(t, "disconnect kill", 5*time.Second, func() bool { return w.Live() == 0 })
}

func TestRefusals(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: SystemSpawner{Shells: map[string][]string{"cmd": {"/no/such/shell"}}}, IdleExit: time.Minute}
	run(t, w)
	f.answers <- start(sid1, "cmd")
	waitFor(t, "shell_unavailable", 3*time.Second, func() bool { return f.has(sid1, func(p OutputPost) bool { return p.Refused == "shell_unavailable" }) })
	f.answers <- start(sid2, "bash")
	waitFor(t, "bad_request", 3*time.Second, func() bool { return f.has(sid2, func(p OutputPost) bool { return p.Refused == "bad_request" }) })
	// A malformed id is ignored outright.
	f.answers <- start("not-an-id", "cmd")
	time.Sleep(200 * time.Millisecond)
	if f.has("not-an-id", func(OutputPost) bool { return true }) {
		t.Fatal("answered a malformed id")
	}
}

func TestTooManyAndOversizeInput(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute}
	run(t, w)
	ids := []string{sid1, sid2, "11111111111111111111111111111111", "22222222222222222222222222222222"}
	for _, id := range ids {
		f.answers <- start(id, "cmd")
	}
	waitFor(t, "too_many", 3*time.Second, func() bool { return f.has(ids[3], func(p OutputPost) bool { return p.Refused == "too_many" }) })
	if w.Live() != MaxLive {
		t.Fatalf("live %d", w.Live())
	}
	big := strings.Repeat("x", InputFrameMax+1)
	f.answers <- input(sid1, 1, big)
	waitFor(t, "oversize input ends it", 3*time.Second, func() bool { return w.Live() == MaxLive-1 })
}

func TestAnotherComputerStopsTheWorker(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute}
	_, done := run(t, w)
	f.answers <- start(sid1, "cmd")
	waitFor(t, "started", 3*time.Second, func() bool { return w.Live() == 1 })
	f.answers <- PollAnswer{EndpointID: "ep2"}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("no error")
		}
		done <- err
	case <-time.After(3 * time.Second):
		t.Fatal("did not stop")
	}
	if w.Live() != 0 {
		t.Fatal("left a shell running")
	}
}

func TestIdleExitWithNothingToDo(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: 200 * time.Millisecond}
	_, done := run(t, w)
	select {
	case err := <-done:
		done <- err
	case <-time.After(3 * time.Second):
		t.Fatal("did not exit")
	}
}

func TestPortalEndOnOutput(t *testing.T) {
	f := newPortal()
	w := &Worker{P: f, S: shSpawner(t), IdleExit: time.Minute, FlushEvery: 20 * time.Millisecond}
	run(t, w)
	f.answers <- start(sid1, "cmd")
	waitFor(t, "started", 3*time.Second, func() bool { return w.Live() == 1 })
	f.mu.Lock()
	f.endOnOut = true
	f.mu.Unlock()
	f.answers <- input(sid1, 1, "echo bye\n")
	waitFor(t, "ended by the portal's answer", 3*time.Second, func() bool { return w.Live() == 0 })
}
