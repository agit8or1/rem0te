package remote

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"sort"
	"sync"
	"time"
)

// ErrShellMissing: the shell's executable is not where it must be.
var ErrShellMissing = errors.New("remote: shell not installed")

// Worker is `rem0te-agent.exe remote-worker`. Run polls until there is
// nothing to do for IdleExit, the portal says stop, or ctx ends; everything
// it started is killed before it returns.
type Worker struct {
	P    Portal
	S    Spawner
	Now  func() time.Time
	Logf func(string, ...any)

	// Test knobs; zero means the constants.
	IdleExit       time.Duration
	DisconnectKill time.Duration
	MaxSession     time.Duration
	IdleTimeout    time.Duration
	Tick           time.Duration
	FlushEvery     time.Duration

	mu       sync.Mutex
	sessions map[string]*session
	endpoint string
}

type chunk struct {
	stream string
	data   []byte
}

type session struct {
	id       string
	proc     Proc
	started  time.Time
	notAfter time.Time
	idleAt   time.Time
	inAcked  int
	bytesIn  int
	outSeq   int
	bytesOut int

	inq     chan []byte
	out     chan chunk
	stopped chan struct{}
	once    sync.Once
	reason  string
	pumped  sync.WaitGroup
}

func (w *Worker) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}

func (w *Worker) logf(f string, a ...any) {
	if w.Logf != nil {
		w.Logf(f, a...)
	}
}

func (w *Worker) d(v, dflt time.Duration) time.Duration {
	if v > 0 {
		return v
	}
	return dflt
}

// Held: what this worker runs, for the next poll.
func (w *Worker) held() []Held {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]Held, 0, len(w.sessions))
	for _, s := range w.sessions {
		out = append(out, Held{ID: s.id, InAcked: s.inAcked})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Live is how many shells this worker runs now.
func (w *Worker) Live() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.sessions)
}

// stop ends one session: the whole process tree is killed, once.
func (w *Worker) stop(s *session, reason string) {
	s.once.Do(func() {
		s.reason = reason
		close(s.stopped)
		s.proc.KillTree()
		// Reap it once its streams have closed (the kill closes them).
		go func() { s.pumped.Wait(); _, _ = s.proc.Wait() }()
		w.mu.Lock()
		delete(w.sessions, s.id)
		w.mu.Unlock()
		w.logf("remote-worker: terminal %s ended (%s)", s.id, reason)
	})
}

func (w *Worker) stopAll(reason string) {
	w.mu.Lock()
	all := make([]*session, 0, len(w.sessions))
	for _, s := range w.sessions {
		all = append(all, s)
	}
	w.mu.Unlock()
	for _, s := range all {
		w.stop(s, reason)
	}
}

// Run is the worker.
func (w *Worker) Run(ctx context.Context) error {
	w.mu.Lock()
	if w.sessions == nil {
		w.sessions = map[string]*session{}
	}
	w.mu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer w.stopAll("worker_exit")
	go w.deadlines(ctx)

	lastOK, lastBusy := w.now(), w.now()
	backoff := time.Second
	for ctx.Err() == nil {
		ans, err := w.P.Poll(ctx, w.held(), true)
		if errors.Is(err, ErrStop) {
			w.logf("remote-worker: the portal said stop")
			return nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			w.logf("remote-worker: poll: %v", err)
			if w.now().Sub(lastOK) >= w.d(w.DisconnectKill, DisconnectKill) {
				w.stopAll("disconnected")
			}
			if w.Live() == 0 && w.now().Sub(lastBusy) >= w.d(w.IdleExit, IdleExit) {
				return nil
			}
			sleep(ctx, backoff)
			if backoff *= 2; backoff > 15*time.Second {
				backoff = 15 * time.Second
			}
			continue
		}
		lastOK, backoff = w.now(), time.Second
		if ans.Superseded {
			sleep(ctx, 500*time.Millisecond)
			continue
		}
		if !w.pin(ans.EndpointID) {
			w.logf("remote-worker: the portal named another computer; stopping")
			return errors.New("endpoint id changed")
		}
		for _, in := range ans.Terminals {
			w.apply(ctx, in)
		}
		if w.Live() > 0 {
			lastBusy = w.now()
		} else if w.now().Sub(lastBusy) >= w.d(w.IdleExit, IdleExit) {
			return nil
		}
	}
	return nil
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func (w *Worker) pin(id string) bool {
	if id == "" {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.endpoint == "" {
		w.endpoint = id
	}
	return w.endpoint == id
}

// deadlines ends a session past its hard limit or idle limit, every Tick,
// whatever the portal does.
func (w *Worker) deadlines(ctx context.Context) {
	t := time.NewTicker(w.d(w.Tick, time.Second))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		now := w.now()
		w.mu.Lock()
		var due []*session
		for _, s := range w.sessions {
			if !now.Before(s.notAfter) || !now.Before(s.idleAt) {
				due = append(due, s)
			}
		}
		w.mu.Unlock()
		for _, s := range due {
			w.stop(s, "expired")
		}
	}
}

func parseTime(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}

func (w *Worker) get(id string) *session {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sessions[id]
}

func (w *Worker) apply(ctx context.Context, in Instruction) {
	if !ValidSessionID(in.ID) {
		return
	}
	switch in.Op {
	case "start":
		w.start(ctx, in)
	case "open":
		s := w.get(in.ID)
		if s == nil {
			return
		}
		w.mu.Lock()
		if t, ok := parseTime(in.NotAfter); ok && t.Before(s.notAfter) {
			s.notAfter = t // the portal may only shorten it
		}
		if t, ok := parseTime(in.IdleAt); ok && t.After(s.idleAt) {
			s.idleAt = t
		}
		if lim := s.started.Add(w.d(w.MaxSession, MaxSession)); s.idleAt.After(lim) {
			s.idleAt = lim
		}
		w.mu.Unlock()
		frames := append([]InFrame(nil), in.Input...)
		sort.Slice(frames, func(i, j int) bool { return frames[i].Seq < frames[j].Seq })
		for _, f := range frames {
			w.mu.Lock()
			next := s.inAcked + 1
			w.mu.Unlock()
			if f.Seq < next {
				continue
			}
			if f.Seq != next {
				break
			}
			b, err := base64.StdEncoding.DecodeString(f.Data)
			if err != nil || len(b) == 0 || len(b) > InputFrameMax {
				w.stop(s, "bad_input")
				return
			}
			w.mu.Lock()
			s.bytesIn += len(b)
			over := s.bytesIn > SessionInputMax
			s.inAcked = f.Seq
			if lim := w.now().Add(w.d(w.IdleTimeout, IdleTimeout)); lim.After(s.idleAt) {
				s.idleAt = lim
			}
			w.mu.Unlock()
			if over {
				w.stop(s, "input_cap")
				return
			}
			select {
			case s.inq <- b:
			case <-s.stopped:
				return
			}
		}
	case "end":
		if s := w.get(in.ID); s != nil {
			w.stop(s, "portal:"+in.Reason)
		}
	}
}

func (w *Worker) refuse(ctx context.Context, id, code string) {
	_, err := w.P.Output(ctx, OutputPost{SessionID: id, Refused: code})
	if err != nil {
		w.logf("remote-worker: refuse %s: %v", id, err)
	}
}

func (w *Worker) start(ctx context.Context, in Instruction) {
	if w.get(in.ID) != nil {
		return
	}
	if !ValidShell(in.Shell) {
		w.refuse(ctx, in.ID, "bad_request")
		return
	}
	if w.Live() >= MaxLive {
		w.refuse(ctx, in.ID, "too_many")
		return
	}
	proc, err := w.S.Start(in.Shell)
	if err != nil {
		w.logf("remote-worker: start %s: %v", in.Shell, err)
		if errors.Is(err, ErrShellMissing) {
			w.refuse(ctx, in.ID, "shell_unavailable")
		} else {
			w.refuse(ctx, in.ID, "start_failed")
		}
		return
	}
	now := w.now()
	s := &session{
		id: in.ID, proc: proc, started: now,
		notAfter: now.Add(w.d(w.MaxSession, MaxSession)),
		idleAt:   now.Add(w.d(w.IdleTimeout, IdleTimeout)),
		inq:      make(chan []byte, 64), out: make(chan chunk, 64), stopped: make(chan struct{}),
	}
	if t, ok := parseTime(in.NotAfter); ok && t.Before(s.notAfter) {
		s.notAfter = t
	}
	if t, ok := parseTime(in.IdleAt); ok && t.After(s.idleAt) && t.Before(s.notAfter) {
		s.idleAt = t
	}
	w.mu.Lock()
	w.sessions[s.id] = s
	w.mu.Unlock()
	w.logf("remote-worker: terminal %s started (%s, pid %d)", s.id, in.Shell, proc.Pid())

	var rep OutputReply
	for i := 0; i < 3; i++ {
		if rep, err = w.P.Output(ctx, OutputPost{SessionID: s.id, Started: true}); err == nil {
			break
		}
		sleep(ctx, time.Duration(i+1)*time.Second)
	}
	if err != nil || rep.End {
		w.stop(s, "not_accepted")
		return
	}
	s.pumped.Add(2)
	go w.read(s, "stdout", proc.Stdout())
	go w.read(s, "stderr", proc.Stderr())
	go w.writeIn(s)
	go w.send(ctx, s)
}

// read copies one stream into frames of at most OutputFrameMax bytes.
func (w *Worker) read(s *session, stream string, r io.Reader) {
	defer s.pumped.Done()
	buf := make([]byte, OutputFrameMax)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			c := chunk{stream: stream, data: append([]byte(nil), buf[:n]...)}
			select {
			case s.out <- c:
			case <-s.stopped:
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// writeIn feeds the shell's stdin, in order.
func (w *Worker) writeIn(s *session) {
	stdin := s.proc.Stdin()
	defer stdin.Close()
	for {
		select {
		case <-s.stopped:
			return
		case b := <-s.inq:
			if _, err := stdin.Write(b); err != nil {
				return
			}
		}
	}
}

// send posts output in batches (every FlushEvery, or OutputFramesPerPost
// frames), then the exit once the shell has exited and its output is out.
func (w *Worker) send(ctx context.Context, s *session) {
	readersDone := make(chan struct{})
	go func() { s.pumped.Wait(); close(readersDone) }()
	flush := time.NewTicker(w.d(w.FlushEvery, 100*time.Millisecond))
	defer flush.Stop()
	var pending []chunk
	post := func() bool {
		if len(pending) == 0 {
			return true
		}
		w.mu.Lock()
		frames := make([]OutFrame, 0, len(pending))
		seq := s.outSeq
		total := 0
		for _, c := range pending {
			seq++
			total += len(c.data)
			frames = append(frames, OutFrame{Seq: seq, Stream: c.stream, Data: base64.StdEncoding.EncodeToString(c.data)})
		}
		w.mu.Unlock()
		var rep OutputReply
		var err error
		for i := 0; i < 5; i++ {
			select {
			case <-s.stopped:
				return false
			default:
			}
			if rep, err = w.P.Output(ctx, OutputPost{SessionID: s.id, Frames: frames}); err == nil {
				break
			}
			sleep(ctx, time.Duration(i+1)*time.Second)
		}
		if err != nil {
			w.stop(s, "output_failed")
			return false
		}
		w.mu.Lock()
		s.outSeq = seq
		s.bytesOut += total
		over := s.bytesOut > SessionOutputMax
		w.mu.Unlock()
		pending = pending[:0]
		if rep.End {
			w.stop(s, "portal:"+rep.Reason)
			return false
		}
		if over {
			w.stop(s, "output_cap")
			return false
		}
		return true
	}
	for {
		select {
		case <-s.stopped:
			return
		case c := <-s.out:
			pending = append(pending, c)
			if len(pending) >= OutputFramesPerPost && !post() {
				return
			}
		case <-flush.C:
			if !post() {
				return
			}
		case <-readersDone:
			// Both streams closed: drain what is queued, post it, then the exit.
			for {
				select {
				case c := <-s.out:
					pending = append(pending, c)
					if len(pending) >= OutputFramesPerPost && !post() {
						return
					}
					continue
				default:
				}
				break
			}
			if !post() {
				return
			}
			code, _ := s.proc.Wait()
			select {
			case <-s.stopped:
				return
			default:
			}
			if _, err := w.P.Output(ctx, OutputPost{SessionID: s.id, Exited: &Exit{Code: code}}); err != nil {
				w.logf("remote-worker: exit %s: %v", s.id, err)
			}
			w.stop(s, "exited")
			return
		}
	}
}
