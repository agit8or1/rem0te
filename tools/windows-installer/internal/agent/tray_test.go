package agent_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/agit8or1/rem0te/windows-installer/internal/agent"
)

// trayWin is the platform fake with a tray installer.
type trayWin struct {
	*fakeWin
	installed string
}

func (f *trayWin) InstallTray(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	f.installed = dst
	return os.WriteFile(dst, b, 0o755)
}

// RunAgent "execs" stage 2 with this platform, so it can install the tray.
func (f *trayWin) RunAgent(exe string, args []string) (int, error) {
	f.stage2Ran = true
	f.self = exe
	o := f.opts
	o.Stage2 = true
	return agent.Run(o, f)
}

func readStatus(t *testing.T, o agent.Options) agent.Status {
	var st agent.Status
	raw, _ := os.ReadFile(o.Paths.StatusFile())
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// Without a signed tray in the release: no tray, and no chat (0.36 chat is the tray's).
func TestNoTrayTargetNoTrayNoChat(t *testing.T) {
	_, f, o := setup(t, agent.ModeInstall)
	tw := &trayWin{fakeWin: f}
	if code, err := agent.Run(o, tw); err != nil || code != 0 {
		t.Fatalf("install: %d %v", code, err)
	}
	st := readStatus(t, o)
	if st.Tray != 0 || st.Chat != 0 || st.TraySHA256 != "" || tw.installed != "" {
		t.Fatalf("status %+v installed %q", st, tw.installed)
	}
}

// A signed tray is fetched, verified and placed in its own directory, and its hash recorded.
func TestSignedTrayInstalled(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	bin := []byte("MZ signed tray build 1")
	p.publish(map[string][]byte{agent.TargetTray: bin}, nil)
	tw := &trayWin{fakeWin: f}
	if code, err := agent.Run(o, tw); err != nil || code != 0 {
		t.Fatalf("install: %d %v", code, err)
	}
	if tw.installed != o.Paths.TrayExe() || filepath.Base(filepath.Dir(tw.installed)) != "tray" {
		t.Fatalf("installed at %q", tw.installed)
	}
	got, _ := os.ReadFile(o.Paths.TrayExe())
	sum := sha256.Sum256(bin)
	st := readStatus(t, o)
	if string(got) != string(bin) || st.TraySHA256 != hex.EncodeToString(sum[:]) || st.Tray != agent.TrayProtocol || st.Chat != 2 {
		t.Fatalf("status %+v", st)
	}
}

// A platform that cannot place a tray installs the agent all the same, without tray or chat.
func TestTrayWithoutInstallerIsSkipped(t *testing.T) {
	p, f, o := setup(t, agent.ModeInstall)
	p.publish(map[string][]byte{agent.TargetTray: []byte("MZ tray")}, nil)
	if code, err := agent.Run(o, f); err != nil || code != 0 {
		t.Fatalf("install: %d %v", code, err)
	}
	if st := readStatus(t, o); st.Tray != 0 || st.Chat != 0 {
		t.Fatalf("status %+v", st)
	}
}
