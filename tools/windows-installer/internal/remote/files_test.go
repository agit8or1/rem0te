//go:build !windows

package remote

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fileWorker(t *testing.T) (*Worker, *memFilePortal, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "C", "Temp"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := newMemFilePortal()
	return &Worker{F: m, FS: RootFS{Root: root}, files: map[string]*fileRun{}}, m, root
}

func randBytes(t *testing.T, n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func up(path string, data []byte, overwrite bool) FileJob {
	n := int64(len(data))
	return FileJob{ID: tid, Op: "start", Direction: "to_computer", Path: path, Overwrite: overwrite, Size: &n, SHA256: hexSHA(data)}
}

func TestUploadRoundTripAcrossChunks(t *testing.T) {
	w, m, root := fileWorker(t)
	m.Up = randBytes(t, 2*FileChunkBytes+123)
	m.WaitFirst = 2
	size, sum, code := w.transfer(context.Background(), up(`C:\Temp\in.bin`, m.Up, false))
	if code != "" || size != int64(len(m.Up)) || sum != hexSHA(m.Up) {
		t.Fatalf("got %d %s %q", size, sum, code)
	}
	got, _ := os.ReadFile(filepath.Join(root, "C", "Temp", "in.bin"))
	if !bytes.Equal(got, m.Up) {
		t.Fatal("content differs")
	}
	if left, _ := filepath.Glob(filepath.Join(root, "C", "Temp", ".rem0te-*")); len(left) != 0 {
		t.Fatalf("temp left: %v", left)
	}
}

func TestUploadEmptyFile(t *testing.T) {
	w, _, root := fileWorker(t)
	if _, _, code := w.transfer(context.Background(), up(`C:\Temp\empty.txt`, nil, false)); code != "" {
		t.Fatal(code)
	}
	if fi, err := os.Stat(filepath.Join(root, "C", "Temp", "empty.txt")); err != nil || fi.Size() != 0 {
		t.Fatal("no empty file")
	}
}

func TestUploadNeverOverwritesWithoutTheFlag(t *testing.T) {
	w, m, root := fileWorker(t)
	target := filepath.Join(root, "C", "Temp", "keep.txt")
	_ = os.WriteFile(target, []byte("original"), 0o644)
	m.Up = []byte("replacement")
	if _, _, code := w.transfer(context.Background(), up(`C:\Temp\keep.txt`, m.Up, false)); code != "exists" {
		t.Fatalf("code %q", code)
	}
	if b, _ := os.ReadFile(target); string(b) != "original" {
		t.Fatal("overwritten")
	}
	if _, _, code := w.transfer(context.Background(), up(`C:\Temp\keep.txt`, m.Up, true)); code != "" {
		t.Fatalf("overwrite: %q", code)
	}
	if b, _ := os.ReadFile(target); string(b) != "replacement" {
		t.Fatal("not replaced")
	}
}

func TestUploadRefusals(t *testing.T) {
	w, m, root := fileWorker(t)
	m.Up = []byte("x")
	_ = os.MkdirAll(filepath.Join(root, "C", "Temp", "dir"), 0o755)
	_ = os.MkdirAll(filepath.Join(root, "C", "Elsewhere"), 0o755)
	_ = os.Symlink(filepath.Join(root, "C", "Elsewhere"), filepath.Join(root, "C", "Temp", "link"))
	_ = os.Symlink(filepath.Join(root, "C", "Elsewhere", "f"), filepath.Join(root, "C", "Temp", "flink"))
	cases := map[string]string{
		`C:\Temp\link\x.txt`:   "reparse_point",
		`C:\Temp\flink`:        "reparse_point",
		`C:\Temp\dir`:          "not_a_file",
		`C:\Nowhere\x.txt`:     "no_folder",
		`C:\Temp\..\x`:         "path_refused",
		`\\server\share\x.txt`: "path_refused",
		`E:\x.txt`:             "path_refused",
	}
	for p, want := range cases {
		if _, _, code := w.transfer(context.Background(), up(p, m.Up, true)); code != want {
			t.Errorf("%s: %q, want %q", p, code, want)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "C", "Elsewhere", "x.txt")); err == nil {
		t.Fatal("wrote through the symlink")
	}
}

func TestUploadHashMismatchLeavesNothing(t *testing.T) {
	w, m, root := fileWorker(t)
	m.Up = randBytes(t, FileChunkBytes+10)
	m.Corrupt = 2
	if _, _, code := w.transfer(context.Background(), up(`C:\Temp\bad.bin`, m.Up, false)); code != "hash_mismatch" {
		t.Fatalf("code %q", code)
	}
	// A declared hash that is not the content's.
	m.Corrupt = 0
	j := up(`C:\Temp\bad.bin`, m.Up, false)
	j.SHA256 = hexSHA([]byte("other"))
	if _, _, code := w.transfer(context.Background(), j); code != "hash_mismatch" {
		t.Fatalf("declared: %q", code)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "C", "Temp"))
	if len(entries) != 0 {
		t.Fatalf("left %v", entries)
	}
}

func TestDownloadRoundTrip(t *testing.T) {
	w, m, root := fileWorker(t)
	data := randBytes(t, 3*FileChunkBytes)
	_ = os.WriteFile(filepath.Join(root, "C", "Temp", "out.bin"), data, 0o644)
	m.WaitFirst = 3
	size, sum, code := w.transfer(context.Background(), FileJob{ID: tid, Op: "start", Direction: "from_computer", Path: `C:\Temp\out.bin`, MaxBytes: 100 << 20})
	if code != "" || size != int64(len(data)) || sum != hexSHA(data) || m.SHA != sum || m.Size != size || !bytes.Equal(m.Down, data) {
		t.Fatalf("got %d %s %q (declared %s)", size, sum, code, m.SHA)
	}
}

func TestDownloadRefusals(t *testing.T) {
	w, _, root := fileWorker(t)
	_ = os.WriteFile(filepath.Join(root, "C", "Temp", "big.bin"), randBytes(t, 2048), 0o644)
	_ = os.Symlink("/etc/hostname", filepath.Join(root, "C", "Temp", "secret"))
	cases := map[string]string{
		`C:\Temp\missing.bin`: "not_found",
		`C:\Temp\secret`:      "reparse_point",
		`C:\Temp`:             "not_a_file",
	}
	for p, want := range cases {
		if _, _, code := w.transfer(context.Background(), FileJob{ID: tid, Direction: "from_computer", Path: p, MaxBytes: 1 << 20}); code != want {
			t.Errorf("%s: %q, want %q", p, code, want)
		}
	}
	if _, _, code := w.transfer(context.Background(), FileJob{ID: tid, Direction: "from_computer", Path: `C:\Temp\big.bin`, MaxBytes: 1024}); code != "too_large" {
		t.Errorf("too_large: %q", code)
	}
}

// The portal ending a transfer mid-way: the worker stops, reports nothing,
// and leaves no temporary file.
func TestPortalEndStopsAndCleansUp(t *testing.T) {
	w, m, root := fileWorker(t)
	m.Up = randBytes(t, 4*FileChunkBytes)
	m.WaitFirst = 1 << 30
	w.applyFile(context.Background(), up(`C:\Temp\slow.bin`, m.Up, false))
	time.Sleep(200 * time.Millisecond)
	if parts, _ := filepath.Glob(filepath.Join(root, "C", "Temp", ".rem0te-*")); len(parts) != 1 {
		t.Fatalf("no temp file while running: %v", parts)
	}
	m.end()
	w.applyFile(context.Background(), FileJob{ID: tid, Op: "end", Reason: "cancelled"})
	w.waitFiles()
	if left, _ := filepath.Glob(filepath.Join(root, "C", "Temp", "*")); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	if _, ok := m.waitFinished(100 * time.Millisecond); ok {
		t.Fatal("reported a finish after the portal ended it")
	}
}

// Through applyFile: the outcome is reported to the portal.
func TestApplyFileReportsOutcome(t *testing.T) {
	w, m, _ := fileWorker(t)
	m.Up = []byte("hello")
	w.applyFile(context.Background(), up(`C:\Temp\hello.txt`, m.Up, false))
	r, ok := m.waitFinished(5 * time.Second)
	if !ok || !r.Done || r.SHA256 != hexSHA(m.Up) {
		t.Fatalf("finish %+v", r)
	}
	w.applyFile(context.Background(), up(`C:\Temp\hello.txt`, m.Up, false))
	r, ok = m.waitFinished(5 * time.Second)
	if !ok || r.Done || r.Reason != "exists" {
		t.Fatalf("second %+v", r)
	}
	if !strings.Contains(strings.Join(AgentFileErrors, ","), "exists") {
		t.Fatal("exists is not an agent error")
	}
}
