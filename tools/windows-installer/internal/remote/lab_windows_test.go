//go:build windows && labwindows

package remote

// The Windows lab (0.77): the terminal's real exec site, SystemSpawner —
// cmd.exe and powershell.exe from System32 in a Job Object — driven by the
// real worker against a fake portal, on GitHub's disposable windows-latest
// runner. Twice: in the test process (the runner's elevated administrator)
// and as SYSTEM in session 0, by running this same test binary from a
// scheduled task (the agent runs as SYSTEM; that is the identity the shell
// gets). It proves: a command runs and its output comes back; ending the
// session kills the shell AND a child it started; the hard limit expiring
// does the same. It does not prove the heartbeat starting the worker, or the
// HTTP channel to a real portal (the e2e suite drives those on Linux).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/labevidence"
)

type labPortal struct {
	mu      sync.Mutex
	answers chan PollAnswer
	posts   []OutputPost
}

func (f *labPortal) Poll(ctx context.Context, _ []Held, _ []string, _ bool) (PollAnswer, error) {
	select {
	case a := <-f.answers:
		return a, nil
	case <-ctx.Done():
		return PollAnswer{}, ctx.Err()
	case <-time.After(100 * time.Millisecond):
		return PollAnswer{EndpointID: "lab"}, nil
	}
}

func (f *labPortal) Output(_ context.Context, p OutputPost) (OutputReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.posts = append(f.posts, p)
	return OutputReply{}, nil
}

func (f *labPortal) text(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var b strings.Builder
	for _, p := range f.posts {
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

func labAlive(pid uint32) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == uint32(windows.WAIT_TIMEOUT)
}

func labWait(what string, d time.Duration, ok func() bool) bool {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if ok() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// labResult is what one run observed, written as JSON for the SYSTEM run.
type labResult struct {
	Whoami         string `json:"whoami"`
	CmdOutput      bool   `json:"cmdOutput"`
	PsOutput       bool   `json:"psOutput"`
	ChildPid       int    `json:"childPid"`
	ChildAliveOpen bool   `json:"childAliveWhileOpen"`
	ChildAfterEnd  bool   `json:"childAliveAfterEnd"`
	ExpChildPid    int    `json:"expiryChildPid"`
	ExpChildAfter  bool   `json:"expiryChildAliveAfter"`
	ExpiredInTime  bool   `json:"expiredInTime"`
	Errors         string `json:"errors,omitempty"`
}

var childRE = regexp.MustCompile(`child=(\d+)`)

func at(d time.Duration) string { return time.Now().Add(d).Format(time.RFC3339Nano) }

func labStart(id, shell string) PollAnswer {
	return PollAnswer{EndpointID: "lab", Terminals: []Instruction{{ID: id, Op: "start", Shell: shell, NotAfter: at(time.Hour), IdleAt: at(15 * time.Minute)}}}
}

func labInput(id string, seq int, s string) PollAnswer {
	return PollAnswer{EndpointID: "lab", Terminals: []Instruction{{ID: id, Op: "open", NotAfter: at(time.Hour), IdleAt: at(15 * time.Minute),
		Input: []InFrame{{Seq: seq, Data: base64.StdEncoding.EncodeToString([]byte(s))}}}}}
}

// exercise runs the whole scenario with the real spawner and returns what it saw.
func exercise() labResult {
	var r labResult
	var errs []string
	f := &labPortal{answers: make(chan PollAnswer, 16)}
	w := &Worker{P: f, S: SystemSpawner{}, IdleExit: 10 * time.Minute, FlushEvery: 50 * time.Millisecond, Tick: 200 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = w.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	// 1. cmd: whoami, then end.
	const c1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	f.answers <- labStart(c1, "cmd")
	f.answers <- labInput(c1, 1, "whoami\necho cmd-ok-%COMPUTERNAME%\n")
	r.CmdOutput = labWait("cmd output", 30*time.Second, func() bool { return strings.Contains(f.text(c1), "cmd-ok-") })
	for _, line := range strings.Split(f.text(c1), "\n") {
		l := strings.ToLower(strings.TrimSpace(line))
		if strings.Contains(l, `\`) && !strings.Contains(l, ">") && !strings.Contains(l, ":") {
			r.Whoami = l
		}
	}
	f.answers <- PollAnswer{EndpointID: "lab", Terminals: []Instruction{{ID: c1, Op: "end", Reason: "closed"}}}
	labWait("cmd ended", 10*time.Second, func() bool { return w.Live() == 0 })

	// 2. PowerShell: start a child (a second powershell.exe sleeping), end, the child must be gone.
	const p1 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	f.answers <- labStart(p1, "powershell")
	f.answers <- labInput(p1, 1, "$c = Start-Process -FilePath \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 600' -WindowStyle Hidden -PassThru; \"child=$($c.Id)\"; \"ps-ok\"\n")
	r.PsOutput = labWait("ps output", 60*time.Second, func() bool { return childRE.MatchString(f.text(p1)) })
	if m := childRE.FindStringSubmatch(f.text(p1)); m != nil {
		r.ChildPid, _ = strconv.Atoi(m[1])
	}
	if r.ChildPid > 0 {
		r.ChildAliveOpen = labAlive(uint32(r.ChildPid))
	}
	f.answers <- PollAnswer{EndpointID: "lab", Terminals: []Instruction{{ID: p1, Op: "end", Reason: "revoked"}}}
	labWait("ps ended", 10*time.Second, func() bool { return w.Live() == 0 })
	time.Sleep(time.Second)
	if r.ChildPid > 0 {
		r.ChildAfterEnd = labAlive(uint32(r.ChildPid))
	}

	// 3. Expiry: the worker's own hard limit, 20 s here, with a child running.
	w2 := &Worker{P: f, S: SystemSpawner{}, IdleExit: 10 * time.Minute, MaxSession: 20 * time.Second, FlushEvery: 50 * time.Millisecond, Tick: 200 * time.Millisecond}
	cancel()
	<-done
	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := make(chan struct{})
	go func() { _ = w2.Run(ctx2); close(done2) }()
	defer func() { cancel2(); <-done2 }()
	done = make(chan struct{})
	close(done)
	const e1 = "cccccccccccccccccccccccccccccccc"
	started := time.Now()
	f.answers <- labStart(e1, "cmd")
	f.answers <- labInput(e1, 1, "start \"\" /b \"%SystemRoot%\\System32\\PING.EXE\" -n 600 127.0.0.1 >NUL\nfor /f \"tokens=2 delims=,\" %a in ('tasklist /fi \"imagename eq PING.EXE\" /fo csv /nh') do @echo child=%~a\n")
	labWait("expiry child pid", 30*time.Second, func() bool { return childRE.MatchString(f.text(e1)) })
	if m := childRE.FindStringSubmatch(f.text(e1)); m != nil {
		r.ExpChildPid, _ = strconv.Atoi(m[1])
	}
	r.ExpiredInTime = labWait("expired", 40*time.Second, func() bool { return w2.Live() == 0 }) && time.Since(started) < 40*time.Second
	time.Sleep(time.Second)
	if r.ExpChildPid > 0 {
		r.ExpChildAfter = labAlive(uint32(r.ExpChildPid))
	}
	r.Errors = strings.Join(errs, "; ")
	return r
}

func check(t *testing.T, n *labevidence.Note, who string, r labResult) {
	t.Helper()
	n.Logf("%s: whoami %q, cmd output %v, ps output %v, child %d alive while open %v, after end %v; expiry child %d alive after %v, expired in time %v",
		who, r.Whoami, r.CmdOutput, r.PsOutput, r.ChildPid, r.ChildAliveOpen, r.ChildAfterEnd, r.ExpChildPid, r.ExpChildAfter, r.ExpiredInTime)
	if !r.CmdOutput || !r.PsOutput {
		t.Errorf("%s: a shell did not answer", who)
	}
	if r.ChildPid <= 0 || !r.ChildAliveOpen {
		t.Errorf("%s: the child never ran, so the tree kill was not tested", who)
	}
	if r.ChildAfterEnd {
		t.Errorf("%s: the child outlived the end of the session", who)
	}
	if r.ExpChildPid <= 0 {
		t.Errorf("%s: the expiry child never ran", who)
	}
	if !r.ExpiredInTime || r.ExpChildAfter {
		t.Errorf("%s: the hard limit did not end the tree (in time %v, child alive %v)", who, r.ExpiredInTime, r.ExpChildAfter)
	}
}

func TestLabTerminalAsAdministrator(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/terminal/administrator")
	check(t, n, "administrator", exercise())
}

const systemDir = `C:\ProgramData\Rem0teLab\terminal`

// TestLabTerminalSystemChild is what the scheduled task runs as SYSTEM. It
// does nothing unless the outer test left its marker.
func TestLabTerminalSystemChild(t *testing.T) {
	if _, err := os.Stat(filepath.Join(systemDir, "go")); err != nil {
		t.Skip("not the SYSTEM child")
	}
	// File transfer first (0.78): result.json is what the outer test waits for.
	fb, _ := json.Marshal(exerciseFiles("system"))
	_ = os.WriteFile(filepath.Join(systemDir, "files.json"), fb, 0o644)
	b, _ := json.Marshal(exercise())
	_ = os.WriteFile(filepath.Join(systemDir, "result.json"), b, 0o644)
}

func TestLabTerminalAsSystem(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/terminal/system")
	_ = os.RemoveAll(systemDir)
	if err := os.MkdirAll(systemDir, 0o755); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(systemDir, "remote.test.exe")
	raw, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, raw, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(systemDir, "go"), nil, 0o644)
	schtasks := filepath.Join(os.Getenv("SystemRoot"), "System32", "schtasks.exe")
	task := "LabRem0teTerminal"
	run := func(args ...string) {
		if o, err := exec.Command(schtasks, args...).CombinedOutput(); err != nil {
			t.Fatalf("schtasks %v: %v %s", args, err, o)
		}
	}
	_ = exec.Command(schtasks, "/Delete", "/TN", task, "/F").Run()
	run("/Create", "/TN", task, "/TR", `"`+exe+`" -test.run ^TestLabTerminalSystemChild$ -test.count 1`, "/SC", "ONCE", "/ST", "00:00", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F")
	defer run("/Delete", "/TN", task, "/F")
	run("/Run", "/TN", task)
	out := filepath.Join(systemDir, "result.json")
	var b []byte
	if !labWait("SYSTEM result", 4*time.Minute, func() bool { var e error; b, e = os.ReadFile(out); return e == nil }) {
		t.Fatal("no result from the SYSTEM run within 4 minutes")
	}
	var r labResult
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	if r.Whoami != `nt authority\system` {
		t.Errorf("the shell ran as %q, not SYSTEM", r.Whoami)
	}
	check(t, n, "SYSTEM (scheduled task, session 0)", r)

	// File transfer as SYSTEM (0.78), from the same run.
	nf := labevidence.Track(t, "agent/files/system")
	fb, err := os.ReadFile(filepath.Join(systemDir, "files.json"))
	if err != nil {
		t.Fatal("no file-transfer result from the SYSTEM run")
	}
	var fr fileLabResult
	if err := json.Unmarshal(fb, &fr); err != nil {
		t.Fatal(err)
	}
	checkFiles(t, nf, "SYSTEM (scheduled task, session 0)", fr)
}
