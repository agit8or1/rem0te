package remote

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

var driveRE = regexp.MustCompile(`^[A-Za-z]:\\`)

// CheckPath is the path rule for a file transfer: "" when the worker may
// touch the path, or a short reason when it may not. It is the same rule as
// the portal's checkPath (apps/api/src/remote-ops/file-policy.ts), tested
// against the same fixture (testdata/file-paths.json).
//
// The path must be absolute and local: a drive letter, a colon, a backslash,
// then at least one name. It is refused if it has any of these:
//   - a UNC or device prefix (\\server\, \\?\, \\.\);
//   - a forward slash, or ".." anywhere;
//   - a "." component, or an empty one (a doubled or trailing backslash);
//   - a name ending in a dot or a space;
//   - a character Windows refuses, or a colon after the drive (a stream);
//   - a reserved device name (CON, NUL, COM1 …), with or without an extension;
//   - fewer than 4 or more than 1,024 characters.
//
// The file system is checked after this, on the computer itself, for
// reparse points along the path and for the file's own type
// (FileSystem.Resolve and the transfer).
func CheckPath(p string) string {
	if !utf8.ValidString(p) {
		return "not a path"
	}
	if n := utf8.RuneCountInString(p); n < FilePathMin || n > FilePathMax {
		return "length"
	}
	if strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, "//") {
		return "network or device path"
	}
	if !driveRE.MatchString(p) {
		return "not an absolute local path"
	}
	if strings.Contains(p, "/") {
		return "forward slash"
	}
	if strings.Contains(p, "..") {
		return `".."`
	}
	for _, c := range strings.Split(p[3:], `\`) {
		if c == "" {
			return "empty component"
		}
		if c == "." {
			return `"."`
		}
		for _, r := range c {
			if r < 0x20 || r == 0x7f || strings.ContainsRune(`<>:"|?*`, r) {
				return "character"
			}
		}
		if strings.HasSuffix(c, ".") || strings.HasSuffix(c, " ") {
			return "trailing dot or space"
		}
		base := strings.ToUpper(strings.TrimRight(strings.SplitN(c, ".", 2)[0], " "))
		for _, r := range ReservedNames {
			if base == r {
				return "reserved name"
			}
		}
	}
	return ""
}

// components: the names after the drive, for a path CheckPath accepted.
func components(p string) []string { return strings.Split(p[3:], `\`) }
