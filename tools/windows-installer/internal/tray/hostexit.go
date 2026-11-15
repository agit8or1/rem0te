package tray

import "encoding/json"

// HostExit is why the signed tray host's loop ended (0.51).
//
// The tray in each session lives exactly as long as the host's pipes: when
// the host leaves, every tray leaves with it (PipeBackend.Gone), and the icon
// disappears. Until 0.51 the host left whenever rem0te-agent.exe was
// replaced — which every signed install did, even with identical bytes —
// and the next one was started only by the next heartbeat. On DEWEY-WKS2022
// two reinstalls ran in seven minutes and the heartbeat then stopped, so the
// icon went after "Test the connection" and did not come back. The test run
// itself was not the cause: net.test only pings the gateway and opens one
// TLS connection.
type HostExit int

const (
	// HostExitDone: nothing to hand over (an error, or nothing to serve).
	HostExitDone HostExit = iota
	// HostExitReplaced: the agent binary changed under the host (an update).
	HostExitReplaced
	// HostExitLifetime: the host reached hostLifetime.
	HostExitLifetime
)

// Relaunch: the host starts its successor itself, after releasing its lock,
// so the trays come back within one reconcile tick instead of at the next
// heartbeat.
func (e HostExit) Relaunch() bool { return e == HostExitReplaced || e == HostExitLifetime }

// FitReply trims a reply's lines, last first, until the frame fits in
// MaxFrameBytes (0.51). CleanLine caps a line at 200 characters, not bytes,
// so sixty lines of non-ASCII text (a localised adapter name or Windows
// error) came to more than 16 KB: the host's WriteFrame refused the reply,
// the error was dropped, and the tray waited three minutes for an answer
// that never came. A trimmed reply says so in its last line.
func FitReply(f Frame) Frame {
	fits := func(f Frame) bool {
		b, err := json.Marshal(f)
		return err == nil && len(b)+1 <= MaxFrameBytes
	}
	if f.T != FrameReply || fits(f) {
		return f
	}
	lines := append([]string(nil), f.Lines...)
	for len(lines) > 0 {
		lines = lines[:len(lines)-1]
		g := f
		g.Lines = append(append([]string(nil), lines...), TrimmedNote)
		if fits(g) {
			return g
		}
	}
	f.Lines = nil
	f.Summary = CleanLine(f.Summary, 100)
	return f
}

// TrimmedNote ends a reply FitReply had to cut.
const TrimmedNote = "(the rest of the result was too long to show)"
