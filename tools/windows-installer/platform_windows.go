//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
)

type winPlatform struct {
	paths agent.Paths
	log   io.Writer
}

func (w *winPlatform) out() io.Writer {
	if w.log == nil {
		return os.Stdout
	}
	return io.MultiWriter(os.Stdout, w.log)
}

// SYSTEM and Administrators, full control, inherited; nothing inherited from
// the parent (ProgramData grants Users create rights by default, which is
// exactly how a planted file ends up at the path an elevated step executes).
const secureSDDL = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

func (w *winPlatform) SecureDir(dir string) error {
	if fi, err := os.Lstat(dir); err == nil {
		if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
			return fmt.Errorf("%s is not a plain directory; refusing to use it", dir)
		}
		attrs, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(dir))
		if err == nil && attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("%s is a reparse point; refusing to use it", dir)
		}
	} else if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(secureSDDL)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// InstallAgent replaces dst even while dst is the running executable: Windows
// refuses to overwrite a running image but allows renaming it.
func (w *winPlatform) InstallAgent(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := w.SecureDir(filepath.Dir(dst)); err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		old := fmt.Sprintf("%s.old-%d", dst, time.Now().UnixNano())
		if err := os.Rename(dst, old); err != nil {
			return err
		}
	}
	if err := os.Rename(src, dst); err != nil {
		// different volume: copy, then remove the staged file
		in, err2 := os.Open(src)
		if err2 != nil {
			return err
		}
		defer in.Close()
		out, err2 := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
		if err2 != nil {
			return err2
		}
		if _, err2 = io.Copy(out, in); err2 != nil {
			out.Close()
			return err2
		}
		out.Close()
		os.Remove(src)
	}
	// Best effort: earlier renamed copies that are no longer running.
	if olds, _ := filepath.Glob(dst + ".old-*"); len(olds) > 0 {
		for _, o := range olds {
			_ = os.Remove(o)
		}
	}
	return nil
}

func (w *winPlatform) RunAgent(exe string, args []string) (int, error) {
	cmd := exec.Command(exe, args...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	return exitCode(cmd.Run())
}

func (w *winPlatform) RunInstaller(script, params string) (int, error) {
	cmd := exec.Command(powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", script, "-ParamsFile", params)
	cmd.Stdout, cmd.Stderr = w.out(), w.out()
	return exitCode(cmd.Run())
}

func powershell() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		p := filepath.Join(root, `System32\WindowsPowerShell\v1.0\powershell.exe`)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "powershell.exe"
}

func exitCode(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return 1, err
}

func (w *winPlatform) SelfPath() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

var verRE = regexp.MustCompile(`([0-9]+\.[0-9]+\.[0-9]+)`)

// RustdeskVersion reads FileVersion through PowerShell, the same way the
// heartbeat does, so the two never disagree about what is installed.
func (w *winPlatform) RustdeskVersion() string {
	exe := filepath.Join(os.Getenv("ProgramFiles"), "RustDesk", "rustdesk.exe")
	if _, err := os.Stat(exe); err != nil {
		return ""
	}
	out, err := exec.Command(powershell(), "-NoProfile", "-NonInteractive", "-Command",
		"(Get-Item -LiteralPath '"+strings.ReplaceAll(exe, "'", "''")+"').VersionInfo.FileVersion").Output()
	if err != nil {
		return ""
	}
	if m := verRE.FindStringSubmatch(string(out)); m != nil {
		return m[1]
	}
	return ""
}

// PriorRelay reads what a legacy install configured: the host from
// heartbeat.dat and the key from the RustDesk service profile's config.
func (w *winPlatform) PriorRelay() (string, string) {
	var host, key string
	if raw, err := os.ReadFile(filepath.Join(w.paths.StateDir, "heartbeat.dat")); err == nil {
		raw = []byte(strings.TrimPrefix(string(raw), "\ufeff"))
		var st struct {
			Host string `json:"host"`
		}
		if json.Unmarshal(raw, &st) == nil && agent.ValidHost(st.Host) {
			host = st.Host
		}
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	for _, p := range []string{
		filepath.Join(root, `ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk2.toml`),
		filepath.Join(root, `System32\config\systemprofile\AppData\Roaming\RustDesk\config\RustDesk2.toml`),
	} {
		if k := tomlKey(p); k != "" {
			key = k
			break
		}
	}
	return host, key
}

var tomlKeyRE = regexp.MustCompile(`^\s*key\s*=\s*['"]([A-Za-z0-9+/=]{16,520})['"]\s*$`)

func tomlKey(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m := tomlKeyRE.FindStringSubmatch(sc.Text()); m != nil {
			return m[1]
		}
	}
	return ""
}

func openLog(p agent.Paths) *os.File {
	dir := filepath.Join(p.StateDir, "Logs")
	_ = os.MkdirAll(dir, 0o700)
	f, err := os.OpenFile(filepath.Join(dir, "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		f, _ = os.Open(os.DevNull)
	}
	fmt.Fprintf(f, "\n=== %s %v\n", time.Now().UTC().Format(time.RFC3339), os.Args[1:])
	return f
}
