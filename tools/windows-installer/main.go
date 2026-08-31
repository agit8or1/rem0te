package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

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

func getScriptURL() string {
	const prefix = "REM0TE_INST_URL:"
	data := urlSlot[len(prefix):]
	if n := bytes.IndexByte(data, 0); n > 0 {
		return string(data[:n])
	}
	return ""
}

// The URL is patched into the binary by the server that served it, and what
// comes back from it is piped straight into an elevated PowerShell. Trusting
// the slot unconditionally meant an http:// value would have handed anyone on
// the network a root shell, and a quote would have escaped the -Command string.
// The server validates this too; a second check here costs nothing.
func isSafeScriptURL(u string) bool {
	if !strings.HasPrefix(u, "https://") || len(u) > 512 {
		return false
	}
	return !strings.ContainsAny(u, "'\"`;|& \t\r\n")
}

func isElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

func selfElevate() {
	exe, err := os.Executable()
	if err != nil {
		msgBox("Could not locate installer: " + err.Error())
		return
	}
	verbPtr, _ := windows.UTF16PtrFromString("runas")
	exePtr, _ := windows.UTF16PtrFromString(exe)
	err = windows.ShellExecute(0, verbPtr, exePtr, nil, nil, 1 /* SW_NORMAL */)
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
	if !isElevated() {
		fmt.Println("  Requesting administrator privileges...")
		selfElevate()
		os.Exit(0)
	}

	setTitle("Reboot Remote Installer")

	url := getScriptURL()
	if !isSafeScriptURL(url) {
		fmt.Println("  ERROR: Installer is not configured correctly.")
		fmt.Println("  Please contact your administrator for a new link.")
		pause()
		os.Exit(1)
	}

	fmt.Println()
	fmt.Println("  Reboot Remote — Remote Support Client Installer")
	fmt.Println("  ------------------------------------------------")
	fmt.Println("  Installing... this takes about 30 seconds.")
	fmt.Println()

	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile", "-ExecutionPolicy", "Bypass",
		"-Command", fmt.Sprintf("irm '%s' | iex", url),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Run(); err != nil {
		fmt.Printf("\n  ERROR: Installation did not complete (%v)\n", err)
		pause()
		os.Exit(1)
	}
}
