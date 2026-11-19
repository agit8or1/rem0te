package msa

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeRunner struct {
	calls [][]string
	fn    func(key string) ReadResult
}

func (f *fakeRunner) Read(ctx context.Context, args []string) ReadResult {
	f.calls = append(f.calls, append([]string(nil), args...))
	return f.fn(args[1])
}

var installed = Facts{Installed: true, ExpectedPath: true, Version: "1.4.7+65", HasFlutter: true, Service: "running"}

func fixedNow() func() time.Time {
	t := time.Date(2026, 11, 19, 18, 0, 0, 500, time.UTC)
	return func() time.Time { t = t.Add(10 * time.Millisecond); return t }
}

func TestReadArgsClosed(t *testing.T) {
	for _, k := range Keys {
		a := ReadArgs(k)
		if len(a) != 2 || a[0] != "--option" || a[1] != k {
			t.Fatalf("ReadArgs(%q) = %v", k, a)
		}
	}
	for _, bad := range []string{"", "password", "--password", "access-mode view", "custom-rendezvous-server", "ACCESS-MODE", "stop-service"} {
		if a := ReadArgs(bad); a != nil {
			t.Fatalf("ReadArgs(%q) = %v, want nil", bad, a)
		}
	}
	if len(Keys) != 11 {
		t.Fatalf("%d keys", len(Keys))
	}
}

// Nothing in this package names RustDesk's password switch.
func TestNoPasswordSwitch(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "--"+"password") {
			t.Fatalf("%s names the password switch", f)
		}
	}
}

func TestParseRead(t *testing.T) {
	cases := []struct {
		out       string
		code      int
		to, trunc bool
		err       error
		want      string
	}{
		{"view", 0, false, false, nil, KeyOK},
		{"", 0, false, false, nil, KeyOK},
		{"use-permanent-password\r\n", 0, false, false, nil, KeyOK},
		{"17", 0, false, false, nil, KeyOK},
		{"two\nlines", 0, false, false, nil, KeyUnparsed},
		{"has space", 0, false, false, nil, KeyUnparsed},
		{strings.Repeat("a", 65), 0, false, false, nil, KeyUnparsed},
		{"x", 0, false, true, nil, KeyUnparsed},
		{strings.Repeat("a", MaxReadBytes+1), 0, false, false, nil, KeyUnparsed},
		{"view", 1, false, false, nil, KeyError},
		{"", 0, false, false, errors.New("boom"), KeyError},
		{"", 0, true, false, errors.New("killed"), KeyTimeout},
		{"<script>", 0, false, false, nil, KeyUnparsed},
	}
	for i, c := range cases {
		if got := ParseRead([]byte(c.out), c.code, c.to, c.trunc, c.err); got != c.want {
			t.Errorf("case %d: %q → %s, want %s", i, c.out, got, c.want)
		}
	}
}

func TestParseVersion(t *testing.T) {
	for _, ok := range []string{"1.4.7+65", "1.4.1", "1.2.3.4", "1.2.3.123456"} {
		if ParseVersion(ok) != ok {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "1.4", "1.4.7-beta", "v1.4.7", "1.4.7+", "1.4.7 ", "12345.1.1", `C:\Users\bob`} {
		if ParseVersion(bad) != "" {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestClassifyBuildAndSummarise(t *testing.T) {
	if ClassifyBuild(true, true) != "flutter" || ClassifyBuild(false, true) != "sciter" || ClassifyBuild(false, false) != "unknown" {
		t.Fatal("ClassifyBuild")
	}
	all := map[string]string{}
	for _, k := range Keys {
		all[k] = KeyOK
	}
	if Summarise(all) != CLIOK || Summarise(map[string]string{}) != CLINotRun {
		t.Fatal("Summarise ok/not_run")
	}
	all["approve-mode"] = KeyTimeout
	if Summarise(all) != CLIPartial {
		t.Fatal("partial")
	}
	none := map[string]string{}
	for _, k := range Keys {
		none[k] = KeyError
	}
	if Summarise(none) != CLIFailed {
		t.Fatal("failed")
	}
}

func TestShouldRun(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	fp := Fingerprint{Version: "1.4.7+65", Size: 100, ModTime: 5}
	if !ShouldRun(nil, now, fp) || !ShouldRun(&State{}, now, fp) {
		t.Fatal("no state must run")
	}
	recent := &State{LastRunAt: now.Add(-time.Hour), Fingerprint: fp}
	if ShouldRun(recent, now, fp) {
		t.Fatal("ran again within 6 h")
	}
	if !ShouldRun(&State{LastRunAt: now.Add(-6 * time.Hour), Fingerprint: fp}, now, fp) {
		t.Fatal("6 h old must run")
	}
	changed := fp
	changed.Version = "1.5.3+70"
	if !ShouldRun(recent, now, changed) {
		t.Fatal("version change must run")
	}
	changed = fp
	changed.ModTime = 6
	if !ShouldRun(recent, now, changed) {
		t.Fatal("replaced exe must run")
	}
	if ShouldRun(&State{LastRunAt: now.Add(5 * time.Minute), Fingerprint: fp}, now, fp) {
		t.Fatal("small skew must not run")
	}
	if !ShouldRun(&State{LastRunAt: now.Add(time.Hour), Fingerprint: fp}, now, fp) {
		t.Fatal("future last run must run")
	}
}

func TestRunAllOK(t *testing.T) {
	r := &fakeRunner{fn: func(string) ReadResult { return ReadResult{Stdout: []byte("Y\r\n")} }}
	rep := Run(context.Background(), r, installed, fixedNow())
	if rep.CLI != CLIOK || len(rep.Keys) != 11 || rep.Build != "flutter" || rep.Service != "running" || rep.Version == nil || *rep.Version != "1.4.7+65" {
		t.Fatalf("%+v", rep)
	}
	if rep.CheckedAt != "2026-11-19T18:00:00Z" || rep.Schema != Schema || rep.DurationMs < 0 {
		t.Fatalf("%+v", rep)
	}
	if len(r.calls) != 11 {
		t.Fatalf("%d calls", len(r.calls))
	}
	for i, c := range r.calls {
		if len(c) != 2 || c[0] != "--option" || c[1] != Keys[i] {
			t.Fatalf("call %d: %v", i, c)
		}
	}
	b, _ := json.Marshal(rep)
	if len(b) > 4096 {
		t.Fatalf("report is %d bytes", len(b))
	}
	for _, f := range []string{`"schema"`, `"checkedAt"`, `"installed"`, `"expectedPath"`, `"version"`, `"build"`, `"service"`, `"cli"`, `"keys"`, `"durationMs"`} {
		if !strings.Contains(string(b), f) {
			t.Fatalf("missing %s in %s", f, b)
		}
	}
}

func TestRunPartialAndGarbage(t *testing.T) {
	r := &fakeRunner{fn: func(k string) ReadResult {
		switch k {
		case "access-mode":
			return ReadResult{TimedOut: true, Err: errors.New("killed")}
		case "enable-audio":
			return ReadResult{Stdout: []byte(strings.Repeat("x", 5000)), Truncated: true}
		case "approve-mode":
			return ReadResult{Stdout: []byte("garbage output\nwith lines")}
		case "enable-tunnel":
			return ReadResult{ExitCode: 3}
		}
		return ReadResult{Stdout: []byte("N")}
	}}
	rep := Run(context.Background(), r, installed, fixedNow())
	if rep.CLI != CLIPartial || rep.Keys["access-mode"] != KeyTimeout || rep.Keys["enable-audio"] != KeyUnparsed ||
		rep.Keys["approve-mode"] != KeyUnparsed || rep.Keys["enable-tunnel"] != KeyError || rep.Keys["enable-keyboard"] != KeyOK {
		t.Fatalf("%+v", rep.Keys)
	}
}

func TestRunAllFail(t *testing.T) {
	r := &fakeRunner{fn: func(string) ReadResult { return ReadResult{Err: errors.New("exec failed"), ExitCode: -1} }}
	rep := Run(context.Background(), r, installed, fixedNow())
	if rep.CLI != CLIFailed {
		t.Fatalf("%+v", rep)
	}
}

func TestRunNotInstalledRunsNothing(t *testing.T) {
	for _, f := range []Facts{
		{Installed: false, ExpectedPath: true, Service: "missing"},
		{Installed: true, ExpectedPath: false, Version: "1.4.7+65", Service: "running"},
		{Installed: false, ExpectedPath: false, Service: "weird"},
	} {
		r := &fakeRunner{fn: func(string) ReadResult { t.Fatal("ran a read"); return ReadResult{} }}
		rep := Run(context.Background(), r, f, fixedNow())
		if rep.CLI != CLINotRun || len(rep.Keys) != 0 || len(r.calls) != 0 {
			t.Fatalf("%+v", rep)
		}
		if f.Service == "weird" && rep.Service != "other" {
			t.Fatal("service not normalised")
		}
		if !f.Installed && rep.ExpectedPath {
			t.Fatal("expectedPath without install")
		}
		b, _ := json.Marshal(rep)
		if !strings.Contains(string(b), `"keys":{}`) {
			t.Fatalf("keys not {}: %s", b)
		}
	}
}

func TestRunBadVersionIsNull(t *testing.T) {
	f := installed
	f.Version = `1.4.7 (C:\Users\someone)`
	r := &fakeRunner{fn: func(string) ReadResult { return ReadResult{} }}
	rep := Run(context.Background(), r, f, fixedNow())
	b, _ := json.Marshal(rep)
	if rep.Version != nil || !strings.Contains(string(b), `"version":null`) {
		t.Fatalf("%s", b)
	}
}

func TestRunWholeRunDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	n := 0
	r := &fakeRunner{fn: func(string) ReadResult {
		n++
		if n == 3 {
			cancel()
		}
		return ReadResult{Stdout: []byte("Y")}
	}}
	rep := Run(ctx, r, installed, fixedNow())
	if n != 3 || rep.CLI != CLIPartial || rep.Keys["auto-disconnect-timeout"] != KeyTimeout {
		t.Fatalf("n=%d %+v", n, rep.Keys)
	}
}
