package remote

import (
	"context"
	"errors"
	"io"
)

// ErrStop: the portal said this computer has no business using the remote
// channel (not the signed agent, not assigned, the device secret refused).
// The worker kills everything and exits.
var ErrStop = errors.New("remote: the portal does not want this computer to poll")

// Held is a terminal this worker runs, with the last input frame it took.
type Held struct {
	ID      string `json:"id"`
	InAcked int    `json:"inAcked"`
}

// InFrame is one input frame, base64.
type InFrame struct {
	Seq  int    `json:"seq"`
	Data string `json:"data"`
}

// Instruction is what one poll says about one terminal: start it, carry on
// (with input, and the portal's deadlines), or end it.
type Instruction struct {
	ID       string    `json:"id"`
	Op       string    `json:"op"`
	Shell    string    `json:"shell,omitempty"`
	NotAfter string    `json:"notAfter,omitempty"`
	IdleAt   string    `json:"idleAt,omitempty"`
	Reason   string    `json:"reason,omitempty"`
	Input    []InFrame `json:"input,omitempty"`
}

// FileJob is what one poll says about one file transfer (0.78): start it, or
// end it. Path, size and hash are the portal's; the worker checks the path
// itself (CheckPath, then the file system) and the hash at its own end.
type FileJob struct {
	ID        string `json:"id"`
	Op        string `json:"op"`
	Direction string `json:"direction,omitempty"`
	Path      string `json:"path,omitempty"`
	Overwrite bool   `json:"overwrite,omitempty"`
	Size      *int64 `json:"size,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
	MaxBytes  int64  `json:"maxBytes,omitempty"`
	NotAfter  string `json:"notAfter,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// PollAnswer is one poll's answer.
type PollAnswer struct {
	EndpointID string        `json:"endpointId"`
	Terminals  []Instruction `json:"terminals"`
	Files      []FileJob     `json:"files"`
	Superseded bool          `json:"superseded"`
}

// OutFrame is one output frame, base64.
type OutFrame struct {
	Seq    int    `json:"seq"`
	Stream string `json:"stream"`
	Data   string `json:"data"`
}

// Exit is the shell's exit code.
type Exit struct {
	Code int `json:"code"`
}

// OutputPost is what the worker says about one terminal.
type OutputPost struct {
	SessionID string     `json:"sessionId"`
	Started   bool       `json:"started,omitempty"`
	Frames    []OutFrame `json:"frames,omitempty"`
	Exited    *Exit      `json:"exited,omitempty"`
	Refused   string     `json:"refused,omitempty"`
}

// OutputReply: whether the portal wants it ended.
type OutputReply struct {
	End    bool   `json:"end"`
	Reason string `json:"reason"`
}

// Portal is the worker's side of POST /remote/agent/poll and
// /remote/agent/terminal/output. The device secret and RustDesk ID are the
// implementation's (HTTPPortal).
type Portal interface {
	Poll(ctx context.Context, held []Held, files []string, wait bool) (PollAnswer, error)
	Output(ctx context.Context, p OutputPost) (OutputReply, error)
}

// FileReply is the portal's answer to a file call. End means the transfer is
// over at the portal (cancelled, expired, paused, refused) and the worker
// stops and cleans up; Wait means try the same call again shortly.
type FileReply struct {
	End       bool   `json:"end"`
	Reason    string `json:"reason"`
	Wait      bool   `json:"wait"`
	Done      bool   `json:"done"`
	Duplicate bool   `json:"duplicate"`
	Seq       int    `json:"seq"`
	Data      string `json:"data"`
	SHA256    string `json:"sha256"`
}

// FilePortal is the worker's side of /remote/agent/files/{pull,begin,push,finish}.
type FilePortal interface {
	FilePull(ctx context.Context, id string, seq int) (FileReply, error)
	FileBegin(ctx context.Context, id string, size int64, sha string) (FileReply, error)
	FilePush(ctx context.Context, id string, seq int, data, sha string) (FileReply, error)
	FileFinish(ctx context.Context, id string, ok bool, size int64, sha, code string) (FileReply, error)
}

// Proc is a running shell and everything it started.
type Proc interface {
	Stdin() io.WriteCloser
	Stdout() io.Reader
	Stderr() io.Reader
	// Wait returns the shell's exit code once it has exited.
	Wait() (int, error)
	// KillTree ends the shell and every process it started (a Job Object on
	// Windows, a process group elsewhere). Safe to call more than once.
	KillTree()
	Pid() int
}

// Spawner starts one of the two shells.
type Spawner interface {
	Start(shell string) (Proc, error)
}
