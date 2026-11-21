//go:build !windows

package remote

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// RootFS is the simulator's and the tests' file system: a Windows path
// C:\a\b is the file <Root>/C/a/b. SIMULATION — on Windows the path is used
// as it is (WinFS), and a reparse point is FILE_ATTRIBUTE_REPARSE_POINT;
// here it is a symlink.
type RootFS struct{ Root string }

// Resolve maps a path CheckPath accepted.
func (r RootFS) Resolve(p string) (string, []string, error) {
	if r.Root == "" || CheckPath(p) != "" {
		return "", nil, errors.New("refused")
	}
	cur := filepath.Join(r.Root, strings.ToUpper(p[:1]))
	if _, err := os.Stat(cur); err != nil {
		return "", nil, errors.New("no such drive")
	}
	var prefixes []string
	for _, c := range components(p) {
		cur = filepath.Join(cur, c)
		prefixes = append(prefixes, cur)
	}
	return cur, prefixes, nil
}

func isReparse(_ string, fi os.FileInfo) bool { return fi.Mode()&os.ModeSymlink != 0 }

// finalPath: where an open handle really is (Linux /proc; elsewhere its name).
func finalPath(f *os.File) (string, error) {
	if p, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd()))); err == nil {
		return p, nil
	}
	return f.Name(), nil
}

func samePath(a, b string) bool {
	ra, err1 := filepath.EvalSymlinks(filepath.Dir(b))
	if err1 != nil {
		return false
	}
	return filepath.Clean(a) == filepath.Join(ra, filepath.Base(b))
}

// place moves tmp to dst: replacing dst only when replace is set, and
// otherwise failing with ErrExists if dst appeared (a hard link cannot
// replace).
func place(tmp, dst string, replace bool) error {
	if replace {
		return os.Rename(tmp, dst)
	}
	if err := os.Link(tmp, dst); err != nil {
		if os.IsExist(err) {
			return ErrExists
		}
		return err
	}
	return os.Remove(tmp)
}
