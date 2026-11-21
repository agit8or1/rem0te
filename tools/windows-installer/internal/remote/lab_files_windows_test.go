//go:build windows && labwindows

package remote

// The Windows lab for file transfer (0.78). The worker's real file code runs
// on WinFS against an in-memory portal (memportal_test.go), on GitHub's
// disposable windows-latest runner. It runs twice: as the runner's
// administrator, and as SYSTEM through the same scheduled task as the
// terminal (TestLabTerminalSystemChild writes files.json).
//
// It proves these things on real NTFS:
//   - a 1.5 MiB file sent to the computer arrives byte for byte, and its
//     SHA-256 is checked;
//   - an existing file is refused without overwrite and replaced with it;
//   - a file fetched back has the same SHA-256 at both ends;
//   - a junction along the path is refused (reparse_point), and nothing is
//     written through it;
//   - a UNC path is refused.
//
// It does not prove the HTTP channel to a real portal. The e2e suite drives
// that on Linux.

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/agit8or1/rem0te/windows-installer/internal/labevidence"
)

type fileLabResult struct {
	UploadOK        bool   `json:"uploadOK"`
	UploadSHA       string `json:"uploadSha256"`
	ExistsRefused   bool   `json:"existsRefused"`
	OverwriteOK     bool   `json:"overwriteOK"`
	DownloadOK      bool   `json:"downloadOK"`
	DownloadSHA     string `json:"downloadSha256"`
	JunctionRefused bool   `json:"junctionRefused"`
	NothingThrough  bool   `json:"nothingWrittenThroughJunction"`
	UNCRefused      bool   `json:"uncRefused"`
	Errors          string `json:"errors,omitempty"`
}

func exerciseFiles(who string) fileLabResult {
	var r fileLabResult
	dir := `C:\ProgramData\Rem0teLab\files-` + who
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		r.Errors = err.Error()
		return r
	}
	m := newMemFilePortal()
	w := &Worker{F: m, FS: WinFS{}, files: map[string]*fileRun{}}
	ctx := context.Background()
	data := make([]byte, 3*FileChunkBytes)
	_, _ = rand.Read(data)
	m.Up = data
	n := int64(len(data))
	job := func(path string, overwrite bool) FileJob {
		return FileJob{ID: tid, Direction: "to_computer", Path: path, Overwrite: overwrite, Size: &n, SHA256: hexSHA(data)}
	}
	target := dir + `\in.bin`
	size, sum, code := w.transfer(ctx, job(target, false))
	got, _ := os.ReadFile(target)
	r.UploadOK = code == "" && size == n && bytes.Equal(got, data)
	r.UploadSHA = sum
	_, _, code = w.transfer(ctx, job(target, false))
	r.ExistsRefused = code == "exists"
	_, _, code = w.transfer(ctx, job(target, true))
	r.OverwriteOK = code == ""

	size, sum, code = w.transfer(ctx, FileJob{ID: tid, Direction: "from_computer", Path: target, MaxBytes: 100 << 20})
	r.DownloadOK = code == "" && size == n && bytes.Equal(m.Down, data) && m.SHA == sum
	r.DownloadSHA = sum

	real := dir + `\real`
	_ = os.MkdirAll(real, 0o755)
	cmd := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	if o, err := exec.Command(cmd, "/c", "mklink", "/J", dir+`\j`, real).CombinedOutput(); err != nil {
		r.Errors = "mklink: " + err.Error() + " " + string(o)
	}
	_, _, code = w.transfer(ctx, job(dir+`\j\x.bin`, true))
	r.JunctionRefused = code == "reparse_point"
	_, err := os.Stat(real + `\x.bin`)
	r.NothingThrough = os.IsNotExist(err)

	_, _, code = w.transfer(ctx, job(`\\localhost\c$\Windows\Temp\x.bin`, true))
	r.UNCRefused = code == "path_refused"
	return r
}

func checkFiles(t *testing.T, n *labevidence.Note, who string, r fileLabResult) {
	t.Helper()
	n.Logf("%s: upload %v (sha256 %s), exists refused %v, overwrite %v, download %v (sha256 %s), junction refused %v, nothing written through it %v, UNC refused %v %s",
		who, r.UploadOK, r.UploadSHA, r.ExistsRefused, r.OverwriteOK, r.DownloadOK, r.DownloadSHA, r.JunctionRefused, r.NothingThrough, r.UNCRefused, r.Errors)
	if !r.UploadOK || !r.DownloadOK || r.UploadSHA == "" || r.UploadSHA != r.DownloadSHA {
		t.Errorf("%s: the round trip failed or the hashes differ", who)
	}
	if !r.ExistsRefused || !r.OverwriteOK {
		t.Errorf("%s: overwrite rules (exists refused %v, overwrite %v)", who, r.ExistsRefused, r.OverwriteOK)
	}
	if !r.JunctionRefused || !r.NothingThrough {
		t.Errorf("%s: a junction was followed", who)
	}
	if !r.UNCRefused {
		t.Errorf("%s: a UNC path was not refused", who)
	}
}

func TestLabFilesAsAdministrator(t *testing.T) {
	labevidence.Require(t)
	n := labevidence.Track(t, "agent/files/administrator")
	checkFiles(t, n, "administrator", exerciseFiles("admin"))
}
