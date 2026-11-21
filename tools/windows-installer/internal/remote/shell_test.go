package remote

import (
	"strings"
	"testing"
)

func TestShellCommandOnlyTwoShellsByAbsolutePath(t *testing.T) {
	p, a, ok := ShellCommand(`C:\Windows\System32`, "cmd")
	if !ok || p != `C:\Windows\System32\cmd.exe` || strings.Join(a, " ") != "/D" {
		t.Fatalf("cmd: %q %q %v", p, a, ok)
	}
	p, a, ok = ShellCommand(`C:\Windows\System32`, "powershell")
	if !ok || p != `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` || strings.Join(a, " ") != "-NoLogo -NoProfile -NonInteractive -Command -" {
		t.Fatalf("powershell: %q %q %v", p, a, ok)
	}
	for _, bad := range []struct{ dir, shell string }{
		{`C:\Windows\System32`, "bash"}, {`C:\Windows\System32`, "pwsh"}, {`C:\Windows\System32`, "cmd.exe"}, {`C:\Windows\System32`, ""},
		{`\\server\share`, "cmd"}, {`C:\Windows\..\Temp`, "cmd"}, {`System32`, "cmd"}, {`//server/share`, "cmd"},
	} {
		if _, _, ok := ShellCommand(bad.dir, bad.shell); ok {
			t.Errorf("accepted %q %q", bad.dir, bad.shell)
		}
	}
}

func TestValidSessionID(t *testing.T) {
	if !ValidSessionID("0123456789abcdef0123456789abcdef") || ValidSessionID("0123456789ABCDEF0123456789abcdef") || ValidSessionID("../x") {
		t.Fatal("session id rule")
	}
}
