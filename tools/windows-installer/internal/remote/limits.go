// Package remote is the agent's remote worker (0.77 Conduit): the background
// terminal, started by the signed heartbeat only when the portal answers
// remotePoll: true. It polls the portal outbound (the computer listens on
// nothing), starts cmd.exe or powershell.exe by absolute System32 path inside
// a Job Object, streams it, and kills the whole tree when the session ends,
// expires, is revoked, or the portal cannot be reached.
//
// Portable: the portal and the process are interfaces, so every decision runs
// under test with fakes and, on Linux, in rem0te-remote-sim. The one exec site
// is spawn_windows.go (Windows) / spawn_unix.go (the tests and the simulator).
//
// The limits below are the portal's (apps/api/src/remote-ops/limits.ts), the
// same numbers; §87 checks they agree. The worker enforces them itself, so a
// portal that asked for more is still cut off here.
package remote

import "time"

const (
	// IdleTimeout: no input from the technician (as the portal last said, or
	// as arrived here) for this long ends the session.
	IdleTimeout = 15 * time.Minute
	// MaxSession: the hard limit from when this worker started the shell,
	// whatever the portal says.
	MaxSession = 60 * time.Minute

	// InputFrameMax: one input frame, in bytes.
	InputFrameMax = 4096
	// OutputFrameMax: one output frame, in bytes.
	OutputFrameMax = 16384
	// SessionInputMax / SessionOutputMax: a whole session.
	SessionInputMax  = 1024 * 1024
	SessionOutputMax = 8 * 1024 * 1024
	// OutputFramesPerPost: frames in one output post.
	OutputFramesPerPost = 16
	// MaxLive: shells this worker runs at once (the portal allows three a computer).
	MaxLive = 3

	// DisconnectKill: the portal unreachable for this long ends every session.
	DisconnectKill = 90 * time.Second
	// IdleExit: with no session, the worker exits after this long.
	IdleExit = 60 * time.Second
)

// Shells: the only two. A name maps to one absolute System32 path and fixed
// arguments (ShellCommand); nothing from the portal reaches the command line.
var Shells = []string{"cmd", "powershell"}

// AgentRefusals: what the worker may say instead of starting a shell.
var AgentRefusals = []string{"shell_unavailable", "start_failed", "too_many", "bad_request"}

// File transfer (0.78 Courier). The same numbers as the portal's limits.ts;
// §87 checks they agree.
const (
	// FileChunkBytes: one chunk, both directions.
	FileChunkBytes = 512 * 1024
	// FileTransferMax: a transfer's hard limit, whatever the portal says.
	FileTransferMax = 60 * time.Minute
	// FileMaxBytes: no transfer is larger, whatever the portal says (2 GiB).
	FileMaxBytes = 2048 * 1024 * 1024
	// FilePathMin / FilePathMax: a path's length, in characters.
	FilePathMin = 4
	FilePathMax = 1024
	// FileLiveMax: transfers this worker runs at once (the portal allows two a computer).
	FileLiveMax = 2
)

// AgentFileErrors: what the worker may report instead of completing; the
// portal's AGENT_FILE_ERRORS, in the same order.
var AgentFileErrors = []string{
	"exists", "not_found", "not_a_file", "no_folder", "reparse_point", "path_refused", "path_changed",
	"too_large", "hash_mismatch", "size_mismatch", "file_changed", "write_failed", "read_failed",
}

// ReservedNames: Windows' device names, refused as any path component with or
// without an extension; the portal's RESERVED_NAMES.
var ReservedNames = []string{
	"CON", "PRN", "AUX", "NUL",
	"COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
	"LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
}
