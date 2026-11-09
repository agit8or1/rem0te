//go:build windows

// rem0te-agent / Rem0te bootstrap for Windows.
//
// Launched with no arguments (the downloaded installer), it reads the portal
// address and claim token from the slot the portal patched in and installs.
//
// What it then runs depends on whether this build carries a trust root
// (trustroot/root.json, written by the release signer before building):
//
//   - With a root: the signed chain. Only files listed in signed metadata are
//     executed — the agent binary itself, the installer script and the
//     RustDesk build — and nothing the portal sends is code.
//   - Without one (CI and development builds): the legacy path, `irm | iex`
//     of the portal's script, which trusts the portal completely. It prints
//     that it is doing so.
//
// Subcommands (run elevated; the heartbeat runs `update` as SYSTEM):
//
//	rem0te-agent.exe install --portal HOST --token HEX   GPO/Intune/local install
//	rem0te-agent.exe migrate [--portal HOST]             legacy agent → signed chain, keeps enrolment
//	rem0te-agent.exe update  [--portal HOST] [--nonce N] signed update (heartbeat)
//	rem0te-agent.exe status                              trust state as JSON
package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
	"github.com/agit8or1/rem0te/windows-installer/internal/trust"
)

//go:embed trustroot/root.json
var embeddedRoot []byte

// urlSlot is patched at serve time with the actual PS1 script URL.
// Layout: 16-byte magic prefix "REM0TE_INST_URL:" followed by 240 bytes
// of null-terminated URL. The server replaces those 240 bytes before serving.
var urlSlot = [256]byte{
	'R', 'E', 'M', '0', 'T', 'E', '_', 'I', 'N', 'S', 'T', '_', 'U', 'R', 'L', ':',
	// 240 bytes follow — zeroed by default, patched to URL at serve time
}

var (
	kernel32            = windows.NewLazySystemDLL("kernel32.dll")
	procSetConsoleTitle = kernel32.NewProc("SetConsoleTitleW")
)

func defaultPaths() agent.Paths {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return agent.Paths{InstallDir: filepath.Join(pf, "Rem0te"), StateDir: filepath.Join(pd, "Rem0te")}
}

func getScriptURL() string {
	const prefix = "REM0TE_INST_URL:"
	data := urlSlot[len(prefix):]
	if n := bytes.IndexByte(data, 0); n > 0 {
		return string(data[:n])
	}
	return ""
}

// The URL is patched into the binary by the server that served it, and on the
// legacy path what comes back from it is piped straight into an elevated
// PowerShell. Trusting the slot unconditionally meant an http:// value would
// have handed anyone on the network a root shell, and a quote would have
// escaped the -Command string. The server validates this too.
func isSafeScriptURL(u string) bool {
	if !strings.HasPrefix(u, "https://") || len(u) > 512 {
		return false
	}
	return !strings.ContainsAny(u, "'\"`;|& \t\r\n")
}

func isElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

func selfElevate(args []string) {
	exe, err := os.Executable()
	if err != nil {
		msgBox("Could not locate installer: " + err.Error())
		return
	}
	verbPtr, _ := windows.UTF16PtrFromString("runas")
	exePtr, _ := windows.UTF16PtrFromString(exe)
	var argPtr *uint16
	if len(args) > 0 {
		argPtr, _ = windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	}
	err = windows.ShellExecute(0, verbPtr, exePtr, argPtr, nil, 1 /* SW_NORMAL */)
	if err != nil {
		msgBox("Administrator rights are required.\n\nRight-click the installer and choose 'Run as administrator'.")
	}
}

func msgBox(text string) {
	caption, _ := windows.UTF16PtrFromString("Reboot Remote Installer")
	msg, _ := windows.UTF16PtrFromString(text)
	_, _ = windows.MessageBox(0, msg, caption, 0x10 /* MB_ICONERROR */ |0x0 /* MB_OK */)
}

func setTitle(title string) {
	ptr, _ := syscall.UTF16PtrFromString(title)
	procSetConsoleTitle.Call(uintptr(unsafe.Pointer(ptr)))
}

func pause() {
	fmt.Print("\n  Press Enter to close this window.")
	fmt.Scanln() //nolint:errcheck
}

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "status" {
		os.Exit(cmdStatus())
	}
	if !isElevated() {
		fmt.Println("  Requesting administrator privileges...")
		selfElevate(args)
		os.Exit(0)
	}
	if len(args) == 0 {
		os.Exit(bootstrap())
	}
	os.Exit(subcommand(args))
}

// bootstrap is the double-clicked installer.
func bootstrap() int {
	setTitle("Reboot Remote Installer")
	fmt.Println()
	fmt.Println("  Reboot Remote — Remote Support Client Installer")
	fmt.Println("  ------------------------------------------------")

	slot := getScriptURL()
	if !isSafeScriptURL(slot) {
		fmt.Println("  ERROR: Installer is not configured correctly.")
		fmt.Println("  Please contact your administrator for a new link.")
		pause()
		return 1
	}
	if !trust.HasRoot(embeddedRoot) {
		return legacyBootstrap(slot)
	}
	portal, token, ok := agent.ParseSlotURL(slot)
	if !ok {
		fmt.Println("  ERROR: Installer link is not a Rem0te portal address.")
		pause()
		return 1
	}
	fmt.Println("  Verifying signed packages and installing... this takes about a minute.")
	code := runAgent(agent.Options{Mode: agent.ModeInstall, PortalHost: portal, ClaimToken: token})
	if code != 0 {
		pause()
	}
	return code
}

func legacyBootstrap(url string) int {
	fmt.Println("  NOTE: this build carries no update-signing root. It will run the")
	fmt.Println("  portal's installer script without verifying it (legacy path).")
	fmt.Println("  Installing... this takes about 30 seconds.")
	fmt.Println()
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile", "-ExecutionPolicy", "Bypass",
		"-Command", fmt.Sprintf("irm '%s' | iex", url),
	)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	if err := cmd.Run(); err != nil {
		fmt.Printf("\n  ERROR: Installation did not complete (%v)\n", err)
		pause()
		return 1
	}
	return 0
}

func subcommand(args []string) int {
	mode := agent.Mode(args[0])
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	portal := fs.String("portal", "", "portal host[:port]")
	token := fs.String("token", "", "claim token (install)")
	nonce := fs.String("nonce", "", "staged-update nonce (update)")
	stage2 := fs.Bool("stage2", false, "internal: running as the installed, verified binary")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	switch mode {
	case agent.ModeInstall, agent.ModeUpdate, agent.ModeMigrate:
	default:
		fmt.Fprintln(os.Stderr, "usage: rem0te-agent.exe install|migrate|update|status [--portal HOST] [--token HEX] [--nonce N]")
		return 2
	}
	if !trust.HasRoot(embeddedRoot) {
		fmt.Fprintln(os.Stderr, "This build carries no update-signing root; use an official release build.")
		return 3
	}
	if *portal == "" {
		*portal = pinnedPortal()
	}
	return runAgent(agent.Options{Mode: mode, PortalHost: *portal, ClaimToken: *token, Nonce: *nonce, Stage2: *stage2})
}

func runAgent(o agent.Options) int {
	o.Root = embeddedRoot
	o.Paths = defaultPaths()
	logf := openLog(o.Paths)
	defer logf.Close()
	code, err := agent.Run(o, &winPlatform{paths: o.Paths, log: logf})
	if err != nil {
		fmt.Fprintf(io.MultiWriter(os.Stderr, logf), "  ERROR: %v\n", err)
		if code == 0 {
			code = 1
		}
	}
	return code
}

// pinnedPortal: an update started by the heartbeat names no portal; use the
// one this machine pinned, then the legacy heartbeat state's host.
func pinnedPortal() string {
	p := defaultPaths()
	var pin agent.Pin
	if raw, err := os.ReadFile(p.PinFile()); err == nil && json.Unmarshal(raw, &pin) == nil && pin.PortalHost != "" {
		return pin.PortalHost
	}
	if h, _ := (&winPlatform{paths: p}).PriorRelay(); h != "" {
		return h
	}
	return ""
}

func cmdStatus() int {
	p := defaultPaths()
	out := map[string]any{"hasTrustRoot": trust.HasRoot(embeddedRoot)}
	if raw, err := os.ReadFile(p.StatusFile()); err == nil {
		var st any
		if json.Unmarshal(raw, &st) == nil {
			out["status"] = st
		}
	}
	if raw, err := os.ReadFile(p.PinFile()); err == nil {
		var pin any
		if json.Unmarshal(raw, &pin) == nil {
			out["pin"] = pin
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(out)
	return 0
}
