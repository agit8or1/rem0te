//go:build windows

package remote

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// WinFS is the agent's file system: the path as it is, on a fixed or
// removable local drive only (never a mapped network drive or a CD).
type WinFS struct{}

// Resolve checks the drive and lists the folders along the path.
func (WinFS) Resolve(p string) (string, []string, error) {
	if CheckPath(p) != "" {
		return "", nil, errors.New("refused")
	}
	root, err := windows.UTF16PtrFromString(strings.ToUpper(p[:3]))
	if err != nil {
		return "", nil, err
	}
	switch windows.GetDriveType(root) {
	case windows.DRIVE_FIXED, windows.DRIVE_REMOVABLE:
	default:
		return "", nil, errors.New("not a local drive")
	}
	cur := p[:2]
	var prefixes []string
	for _, c := range components(p) {
		cur = cur + `\` + c
		prefixes = append(prefixes, cur)
	}
	return p, prefixes, nil
}

// isReparse: a symlink, junction, mount point or any other reparse point.
func isReparse(p string, _ os.FileInfo) bool {
	u, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return true
	}
	a, err := windows.GetFileAttributes(u)
	if err != nil {
		return true
	}
	return a&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// finalPath: the handle's real path (GetFinalPathNameByHandle), in DOS form.
func finalPath(f *os.File) (string, error) {
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(f.Fd()), &buf[0], uint32(len(buf)), 0) // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS, both 0
	if err != nil {
		return "", err
	}
	if int(n) > len(buf) {
		return "", errors.New("path too long")
	}
	p := windows.UTF16ToString(buf[:n])
	p = strings.TrimPrefix(p, `\\?\`)
	return p, nil
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// place moves tmp to dst with MoveFileEx: MOVEFILE_REPLACE_EXISTING only when
// replace is set, so otherwise an existing dst is ErrExists.
func place(tmp, dst string, replace bool) error {
	from, err := windows.UTF16PtrFromString(tmp)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	flags := uint32(windows.MOVEFILE_WRITE_THROUGH)
	if replace {
		flags |= windows.MOVEFILE_REPLACE_EXISTING
	}
	if err := windows.MoveFileEx(from, to, flags); err != nil {
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_FILE_EXISTS) {
			return ErrExists
		}
		return err
	}
	return nil
}
