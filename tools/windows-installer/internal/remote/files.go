package remote

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// File transfer (0.78 Courier): the worker's half. Both directions read and
// write through os on a path the FileSystem resolved. The rules:
//
//   - CheckPath first. Then every folder along the path must exist, be a
//     folder and not be a reparse point (a symlink or junction). Neither may
//     the target.
//   - A file sent to the computer goes into a new temporary file beside the
//     target (O_EXCL, never an existing file). It is hashed as it is written,
//     and put in place only when its SHA-256 is the one the browser declared.
//   - The target is never replaced unless the request said overwrite. Then it
//     must be a regular file.
//   - Every handle opened is checked to be on the path that was asked for
//     (finalPath), so a folder swapped for a junction mid-way is caught
//     (path_changed).
//   - A file fetched from the computer is hashed once before anything is
//     sent, and that SHA-256 is declared. It is hashed again while sending,
//     and a difference fails the transfer (file_changed).

// FileSystem maps a path CheckPath accepted to this computer's own path.
// Prefixes are the local path of each folder along it, outermost first, then
// the target: the worker checks each one for a reparse point.
type FileSystem interface {
	Resolve(winPath string) (local string, prefixes []string, err error)
}

// ErrExists: place found the target already there.
var ErrExists = errors.New("remote: the target exists")

// errEnded: the portal ended the transfer; nothing to report back.
const errEnded = "_ended"

type fileRun struct {
	id     string
	cancel context.CancelFunc
	done   chan struct{}
}

var transferIDRE = regexp.MustCompile(`^[0-9a-f]{32}$`)
var sha256RE = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (w *Worker) heldFiles() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]string, 0, len(w.files))
	for id := range w.files {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func (w *Worker) cancelFiles() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, f := range w.files {
		f.cancel()
	}
}

// waitFiles cancels every transfer and waits for each to clean up.
func (w *Worker) waitFiles() {
	w.mu.Lock()
	runs := make([]*fileRun, 0, len(w.files))
	for _, f := range w.files {
		f.cancel()
		runs = append(runs, f)
	}
	w.mu.Unlock()
	for _, f := range runs {
		<-f.done
	}
}

func (w *Worker) applyFile(ctx context.Context, j FileJob) {
	if !transferIDRE.MatchString(j.ID) {
		return
	}
	switch j.Op {
	case "end":
		w.mu.Lock()
		if f := w.files[j.ID]; f != nil {
			f.cancel()
		}
		w.mu.Unlock()
	case "start":
		w.mu.Lock()
		if w.files[j.ID] != nil {
			w.mu.Unlock()
			return
		}
		if len(w.files) >= FileLiveMax {
			w.mu.Unlock()
			w.finish(ctx, j.ID, 0, "", "path_refused")
			return
		}
		deadline := w.now().Add(FileTransferMax)
		if t, ok := parseTime(j.NotAfter); ok && t.Before(deadline) {
			deadline = t
		}
		fctx, cancel := context.WithDeadline(ctx, deadline)
		run := &fileRun{id: j.ID, cancel: cancel, done: make(chan struct{})}
		w.files[j.ID] = run
		w.mu.Unlock()
		w.logf("remote-worker: transfer %s started (%s)", j.ID, j.Direction)
		go func() {
			defer close(run.done)
			defer cancel()
			size, sum, code := w.transfer(fctx, j)
			switch {
			case code == errEnded:
				w.logf("remote-worker: transfer %s ended by the portal", j.ID)
			case fctx.Err() != nil && code != "":
				w.logf("remote-worker: transfer %s stopped (%s)", j.ID, code)
			default:
				w.finish(ctx, j.ID, size, sum, code)
				if code == "" {
					w.logf("remote-worker: transfer %s completed", j.ID)
				} else {
					w.logf("remote-worker: transfer %s failed (%s)", j.ID, code)
				}
			}
			w.mu.Lock()
			delete(w.files, j.ID)
			w.mu.Unlock()
		}()
	}
}

// finish reports the outcome, retrying while the portal is unreachable.
func (w *Worker) finish(ctx context.Context, id string, size int64, sum, code string) {
	if w.F == nil {
		return
	}
	_ = w.retry(ctx, func(c context.Context) (bool, error) {
		_, err := w.F.FileFinish(c, id, code == "", size, sum, code)
		return true, err
	})
}

// retry calls fn until it succeeds, the portal has been unreachable for
// DisconnectKill, or ctx ends. fn returns (done, err): an error is retried;
// done=false with no error means "wait" and is retried after a short pause.
func (w *Worker) retry(ctx context.Context, fn func(context.Context) (bool, error)) error {
	first := w.now()
	pause := 300 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		done, err := fn(ctx)
		if err == nil && done {
			return nil
		}
		if err == nil {
			first = w.now() // the portal answered: it is reachable
		} else if w.now().Sub(first) >= w.d(w.DisconnectKill, DisconnectKill) {
			return err
		}
		sleep(ctx, pause)
	}
}

func (w *Worker) transfer(ctx context.Context, j FileJob) (int64, string, string) {
	if w.F == nil || w.FS == nil {
		return 0, "", "path_refused"
	}
	if CheckPath(j.Path) != "" {
		return 0, "", "path_refused"
	}
	local, prefixes, err := w.FS.Resolve(j.Path)
	if err != nil || len(prefixes) < 1 {
		return 0, "", "path_refused"
	}
	// Every folder along the way: there, a folder, not a reparse point.
	for _, p := range prefixes[:len(prefixes)-1] {
		fi, err := os.Lstat(p)
		if err != nil {
			return 0, "", "no_folder"
		}
		if isReparse(p, fi) {
			return 0, "", "reparse_point"
		}
		if !fi.IsDir() {
			return 0, "", "no_folder"
		}
	}
	switch j.Direction {
	case "to_computer":
		if j.Size == nil || *j.Size < 0 || *j.Size > FileMaxBytes || !sha256RE.MatchString(j.SHA256) {
			return 0, "", "size_mismatch"
		}
		return w.receive(ctx, j, local)
	case "from_computer":
		return w.sendFile(ctx, j, local)
	}
	return 0, "", "path_refused"
}

// receive writes an upload to local.
func (w *Worker) receive(ctx context.Context, j FileJob, local string) (int64, string, string) {
	size := *j.Size
	exists := false
	if fi, err := os.Lstat(local); err == nil {
		if isReparse(local, fi) {
			return 0, "", "reparse_point"
		}
		if !fi.Mode().IsRegular() {
			return 0, "", "not_a_file"
		}
		if !j.Overwrite {
			return 0, "", "exists"
		}
		exists = true
	} else if !os.IsNotExist(err) {
		return 0, "", "write_failed"
	}
	tmp := filepath.Join(filepath.Dir(local), ".rem0te-"+j.ID+".part")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 0, "", "write_failed"
	}
	placed := false
	defer func() {
		if !placed {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if fp, err := finalPath(f); err != nil || !samePath(fp, tmp) {
		return 0, "", "path_changed"
	}
	h := sha256.New()
	var total int64
	seq := 1
	for total < size {
		var rep FileReply
		err := w.retry(ctx, func(c context.Context) (bool, error) {
			r, err := w.F.FilePull(c, j.ID, seq)
			if err != nil {
				return false, err
			}
			rep = r
			return !r.Wait, nil
		})
		if err != nil {
			return 0, "", errEnded
		}
		if rep.End {
			return 0, "", errEnded
		}
		if rep.Done || rep.Seq != seq {
			return 0, "", "size_mismatch"
		}
		b, err := base64.StdEncoding.DecodeString(rep.Data)
		if err != nil || len(b) == 0 || len(b) > FileChunkBytes {
			return 0, "", "size_mismatch"
		}
		if s := sha256.Sum256(b); hex.EncodeToString(s[:]) != rep.SHA256 {
			return 0, "", "hash_mismatch"
		}
		if total+int64(len(b)) > size {
			return 0, "", "size_mismatch"
		}
		if _, err := f.Write(b); err != nil {
			return 0, "", "write_failed"
		}
		h.Write(b)
		total += int64(len(b))
		seq++
	}
	// Acknowledge the last chunk, so the portal holds nothing more.
	_, _ = w.F.FilePull(ctx, j.ID, seq)
	if err := f.Sync(); err != nil {
		return 0, "", "write_failed"
	}
	if err := f.Close(); err != nil {
		return 0, "", "write_failed"
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if sum != j.SHA256 {
		return 0, "", "hash_mismatch"
	}
	if ctx.Err() != nil {
		return 0, "", errEnded
	}
	// Look again just before placing it: nothing may have become a reparse point.
	if fi, err := os.Lstat(local); err == nil && (isReparse(local, fi) || !fi.Mode().IsRegular()) {
		return 0, "", "reparse_point"
	}
	if err := place(tmp, local, exists && j.Overwrite); err != nil {
		if errors.Is(err, ErrExists) {
			return 0, "", "exists"
		}
		return 0, "", "write_failed"
	}
	placed = true
	// And it is where it was asked to be.
	if g, err := os.Open(local); err == nil {
		fp, ferr := finalPath(g)
		_ = g.Close()
		if ferr != nil || !samePath(fp, local) {
			return 0, "", "path_changed"
		}
	} else {
		return 0, "", "write_failed"
	}
	return total, sum, ""
}

// sendFile reads a download from local.
func (w *Worker) sendFile(ctx context.Context, j FileJob, local string) (int64, string, string) {
	fi, err := os.Lstat(local)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, "", "not_found"
		}
		return 0, "", "read_failed"
	}
	if isReparse(local, fi) {
		return 0, "", "reparse_point"
	}
	if !fi.Mode().IsRegular() {
		return 0, "", "not_a_file"
	}
	limit := int64(FileMaxBytes)
	if j.MaxBytes > 0 && j.MaxBytes < limit {
		limit = j.MaxBytes
	}
	if fi.Size() > limit {
		return 0, "", "too_large"
	}
	f, err := os.Open(local)
	if err != nil {
		return 0, "", "read_failed"
	}
	defer f.Close()
	if fp, err := finalPath(f); err != nil || !samePath(fp, local) {
		return 0, "", "path_changed"
	}
	st, err := f.Stat()
	if err != nil {
		return 0, "", "read_failed"
	}
	size := st.Size()
	if size > limit {
		return 0, "", "too_large"
	}
	h1 := sha256.New()
	if n, err := io.Copy(h1, f); err != nil || n != size {
		return 0, "", "file_changed"
	}
	sum := hex.EncodeToString(h1.Sum(nil))
	var rep FileReply
	if err := w.retry(ctx, func(c context.Context) (bool, error) {
		r, err := w.F.FileBegin(c, j.ID, size, sum)
		rep = r
		return err == nil, err
	}); err != nil || rep.End {
		return 0, "", errEnded
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0, "", "read_failed"
	}
	h2 := sha256.New()
	buf := make([]byte, FileChunkBytes)
	var total int64
	for seq := 1; ; seq++ {
		n, rerr := io.ReadFull(f, buf)
		if n > 0 {
			b := buf[:n]
			h2.Write(b)
			total += int64(n)
			if total > size {
				return 0, "", "file_changed"
			}
			s := sha256.Sum256(b)
			data, cs := base64.StdEncoding.EncodeToString(b), hex.EncodeToString(s[:])
			if err := w.retry(ctx, func(c context.Context) (bool, error) {
				r, err := w.F.FilePush(c, j.ID, seq, data, cs)
				if err != nil {
					return false, err
				}
				rep = r
				return !r.Wait, nil
			}); err != nil || rep.End {
				return 0, "", errEnded
			}
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			return 0, "", "read_failed"
		}
	}
	if total != size || hex.EncodeToString(h2.Sum(nil)) != sum {
		return 0, "", "file_changed"
	}
	return size, sum, ""
}
