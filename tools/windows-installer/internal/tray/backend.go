package tray

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"sync"
	"time"
)

// Backend is what the tray's UI calls. The signed tray talks to the SYSTEM
// host over its pipes (PipeBackend); the standard tray runs a Core itself
// (LocalBackend). The UI cannot tell which, and does not need to.
type Backend interface {
	// Start begins delivering states to onState, until Close.
	Start(onState func(State))
	OpenChat(ctx context.Context) (string, error)
	Support(ctx context.Context, text string, usage bool, shot []byte) error
	SelfHelp(ctx context.Context, tool string) (Result, error)
	Seen(ids []string)
	Kick()
	Close()
}

// ── Signed: over the pipes ───────────────────────────────────────────────────

type PipeBackend struct {
	r      *Reader
	w      io.Writer
	closer func()
	wmu    sync.Mutex
	mu     sync.Mutex
	wait   map[string]chan Frame
	gone   chan struct{}
	once   sync.Once
	Logf   func(string, ...any)
}

// NewPipeBackend sends the hello with the nonce from the command line. down
// is the host→tray pipe, up the tray→host pipe.
func NewPipeBackend(down io.Reader, up io.Writer, nonce string, closer func()) (*PipeBackend, error) {
	if !ValidNonce(nonce) {
		return nil, errors.New("bad nonce")
	}
	b := &PipeBackend{r: NewReader(down), w: up, closer: closer, wait: map[string]chan Frame{}, gone: make(chan struct{})}
	if err := WriteFrame(up, Frame{T: FrameHello, Nonce: nonce}); err != nil {
		return nil, err
	}
	return b, nil
}

// ErrHostGone: the tray host closed the pipes (the agent stopped, or was updated).
var ErrHostGone = errors.New("the agent's tray host is not running")

func (b *PipeBackend) Start(onState func(State)) {
	go func() {
		defer b.Close()
		for {
			f, err := b.r.Next()
			if err == nil {
				f, err = CheckFromHost(f)
			}
			if err != nil {
				if b.Logf != nil && !errors.Is(err, io.EOF) {
					b.Logf("tray: host frame: %v", err)
				}
				return
			}
			switch f.T {
			case FrameState:
				onState(*f.State)
			case FrameReply:
				b.mu.Lock()
				ch := b.wait[f.ID]
				delete(b.wait, f.ID)
				b.mu.Unlock()
				if ch != nil {
					ch <- f
				}
			}
		}
	}()
}

func (b *PipeBackend) ask(ctx context.Context, f Frame) (Frame, error) {
	f.ID = newReqID()
	ch := make(chan Frame, 1)
	b.mu.Lock()
	b.wait[f.ID] = ch
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.wait, f.ID); b.mu.Unlock() }()
	b.wmu.Lock()
	err := WriteFrame(b.w, f)
	b.wmu.Unlock()
	if err != nil {
		return Frame{}, ErrHostGone
	}
	select {
	case r := <-ch:
		return r, nil
	case <-b.gone:
		return Frame{}, ErrHostGone
	case <-ctx.Done():
		return Frame{}, ctx.Err()
	}
}

func (b *PipeBackend) OpenChat(ctx context.Context) (string, error) {
	r, err := b.ask(ctx, Frame{T: FrameCode})
	if err != nil {
		return "", err
	}
	if !r.OK {
		return "", errors.New(r.Reason)
	}
	return r.URL, nil
}

func (b *PipeBackend) Support(ctx context.Context, text string, usage bool, shot []byte) error {
	f := Frame{T: FrameSupport, Text: text, Usage: usage}
	if len(shot) > 0 {
		f.Shot = base64.StdEncoding.EncodeToString(shot)
	}
	if _, err := CheckFromTray(Frame{T: f.T, ID: "00000000", Text: f.Text, Usage: f.Usage, Shot: f.Shot}); err != nil {
		return err
	}
	r, err := b.ask(ctx, f)
	if err != nil {
		return err
	}
	if !r.OK {
		return errors.New(r.Reason)
	}
	return nil
}

func (b *PipeBackend) SelfHelp(ctx context.Context, tool string) (Result, error) {
	r, err := b.ask(ctx, Frame{T: FrameSelfHelp, Tool: tool})
	if err != nil {
		return Result{}, err
	}
	if r.Outcome == "" {
		return Result{}, errors.New(r.Reason)
	}
	return Result{Outcome: r.Outcome, Summary: r.Summary, Lines: r.Lines}, nil
}

func (b *PipeBackend) Seen(ids []string) {
	if len(ids) == 0 {
		return
	}
	if len(ids) > 100 {
		ids = ids[:100]
	}
	b.wmu.Lock()
	_ = WriteFrame(b.w, Frame{T: FrameSeen, IDs: ids})
	b.wmu.Unlock()
}

// Kick: the host refreshes on its own schedule and on the heartbeat's signal.
func (b *PipeBackend) Kick() {}

func (b *PipeBackend) Close() {
	b.once.Do(func() {
		close(b.gone)
		if b.closer != nil {
			b.closer()
		}
	})
}

// Gone is closed when the host's pipes are.
func (b *PipeBackend) Gone() <-chan struct{} { return b.gone }

// ── Standard: in process ─────────────────────────────────────────────────────

// LocalBackend is the standard tray: a Core holding the tray key, running the
// read-only tools in the user's own session.
type LocalBackend struct {
	Core *Core
	User string
	kick chan struct{}
	stop chan struct{}
	once sync.Once
}

func NewLocalBackend(c *Core, user string) *LocalBackend {
	return &LocalBackend{Core: c, User: user, kick: make(chan struct{}, 1), stop: make(chan struct{})}
}

func (b *LocalBackend) Start(onState func(State)) {
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			st, poll, err := b.Core.Refresh(ctx, b.User, true)
			if err == nil {
				b.Core.FlushPending(ctx)
			}
			cancel()
			onState(st)
			select {
			case <-b.stop:
				return
			case <-b.kick:
			case <-time.After(poll):
			}
		}
	}()
}

func (b *LocalBackend) OpenChat(ctx context.Context) (string, error) {
	u, err := b.Core.OpenChat(ctx, b.User)
	if err != nil {
		return "", errors.New(reason(err, "The chat could not be opened"))
	}
	return u, nil
}

func (b *LocalBackend) Support(ctx context.Context, text string, usage bool, shot []byte) error {
	if _, err := b.Core.Support(ctx, b.User, text, usage, shot); err != nil {
		return errors.New(reason(err, "The request could not be sent"))
	}
	return nil
}

func (b *LocalBackend) SelfHelp(ctx context.Context, tool string) (Result, error) {
	return b.Core.SelfHelp(ctx, b.User, tool), nil
}

func (b *LocalBackend) Seen(ids []string) { b.Core.Seen(ids); b.Kick() }

func (b *LocalBackend) Kick() {
	select {
	case b.kick <- struct{}{}:
	default:
	}
}

func (b *LocalBackend) Close() { b.once.Do(func() { close(b.stop) }) }
