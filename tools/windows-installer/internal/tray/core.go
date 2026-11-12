package tray

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Core is what the tray can do, in one place, for both agents:
//
//   - signed: the SYSTEM tray host holds one Core (device secret, every
//     tool, elevated) and serves each session's tray over its pipes (Serve).
//   - standard: the tray itself holds a Core (tray key, read-only tools) and
//     the UI calls it directly (LocalBackend).
//
// Every request is checked here before it reaches the portal or the OS:
// the catalog, the local rate limits, and — for an elevated tool — the
// containment state and the signed pause.
type Core struct {
	API     *Client
	Portal  string
	Agent   string // "signed" | "standard"
	Version string
	Run     *Runner
	Lim     *Limits
	Now     func() time.Time
	// Sample reads current resource usage. Nil: not offered.
	Sample func() (*Usage, error)
	// SignedPause (signed host only) refreshes the signed pause and says
	// whether it stops actions on this computer, in this business as the
	// portal last named it ("" = not paused). An error means it could not be
	// read now.
	SignedPause func(ctx context.Context, businessID string) (string, error)
	Logf        func(string, ...any)

	mu        sync.Mutex
	lastOK    time.Time // last answer from the portal, any user
	business  string
	lastState map[string]State
	pauseAt   time.Time
	pauseMsg  string
	pending   []RunReport
	delivered map[string]bool
}

// OfflineGrace: how old the last portal answer and the last signed pause may
// be for an elevated tool to run while the portal cannot be reached.
const OfflineGrace = time.Hour

func (c *Core) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Core) logf(f string, a ...any) {
	if c.Logf != nil {
		c.Logf(f, a...)
	}
}

func (c *Core) init() {
	if c.lastState == nil {
		c.lastState = map[string]State{}
	}
	if c.delivered == nil {
		c.delivered = map[string]bool{}
	}
	if c.Lim == nil {
		c.Lim = NewLimits()
	}
}

// Seen: the tray has shown these technician messages (as its badge); the
// next status call reports them delivered.
func (c *Core) Seen(ids []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	for _, id := range ids {
		if ValidID(id) && len(c.delivered) < 200 {
			c.delivered[id] = true
		}
	}
}

// Refresh asks the portal for this user's state. On failure it returns the
// last state it had, marked Offline, and the error.
func (c *Core) Refresh(ctx context.Context, user string, console bool) (State, time.Duration, error) {
	c.mu.Lock()
	c.init()
	var deliver []string
	for id := range c.delivered {
		deliver = append(deliver, id)
	}
	c.mu.Unlock()

	ps, err := c.API.Status(ctx, user, deliver)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		st, ok := c.lastState[user]
		if !ok {
			st = State{Agent: c.Agent, Version: c.Version, Portal: c.Portal, Tools: c.offlineTools()}
		}
		st.Offline = true
		st.Console = console
		st.Chat.AutoOpen = false
		return CleanState(st), time.Minute, err
	}
	for _, id := range deliver {
		delete(c.delivered, id)
	}
	c.lastOK = c.now()
	if ValidID(ps.BusinessID) {
		c.business = ps.BusinessID
	}
	st := State{
		Business: ps.BusinessName, Provider: ps.ProviderName, SupportText: ps.SupportText, Accent: ps.Accent,
		Agent: c.Agent, Version: c.Version, Portal: c.Portal, HasBusiness: ps.HasBusiness, RecordNew: ps.RecordNew, Console: console,
		Chat: ChatState{Open: ps.Chat.Open, ConversationID: ps.Chat.ConversationID, StartedBy: ps.Chat.StartedBy, Recorded: ps.Chat.Recorded,
			Unread: ps.Chat.Unread, AutoOpen: ps.Chat.AutoOpen && console, OtherUser: ps.Chat.OtherUser},
	}
	if ps.Contained.Remote != nil {
		st.Remote = *ps.Contained.Remote
	}
	if ps.Contained.Actions != nil {
		st.Actions = *ps.Contained.Actions
	}
	for _, t := range ps.SelfHelp {
		def, ok := Tool(t.ID)
		if !ok || (def.Elevated && !c.Run.Elevated) {
			continue
		}
		ts := ToolState{ID: def.ID}
		if t.Blocked != nil {
			ts.Blocked = *t.Blocked
		}
		st.Tools = append(st.Tools, ts)
	}
	st = CleanState(st)
	c.lastState[user] = st
	poll := time.Duration(ps.PollSeconds) * time.Second
	if poll < 10*time.Second || poll > 30*time.Minute {
		poll = 10 * time.Minute
	}
	return st, poll, nil
}

// offlineTools: before the portal has ever answered, only the read-only tools.
func (c *Core) offlineTools() []ToolState {
	var out []ToolState
	for _, t := range Catalog {
		if !t.Elevated {
			out = append(out, ToolState{ID: t.ID})
		}
	}
	return out
}

// OpenChat mints a one-time code and returns the /assist URL built from the
// pinned portal.
func (c *Core) OpenChat(ctx context.Context, user string) (string, error) {
	code, err := c.API.ChatCode(ctx, user)
	if err != nil {
		return "", err
	}
	return AssistURL(c.Portal, code)
}

// ErrLimited is a local rate-limit refusal.
var ErrLimited = errors.New("too many requests from this computer: try again later")

// Support sends a request. shot is the JPEG the tray captured and showed
// (nil if the person did not tick the box, or removed it).
func (c *Core) Support(ctx context.Context, user, text string, usage bool, shot []byte) (string, error) {
	t, err := CleanRequestText(text)
	if err != nil {
		return "", err
	}
	if len(shot) > MaxScreenshotBytes {
		return "", fmt.Errorf("the screenshot is over %d KB", MaxScreenshotBytes>>10)
	}
	c.mu.Lock()
	c.init()
	c.mu.Unlock()
	if !c.Lim.AllowSupport(user) {
		return "", ErrLimited
	}
	var u *Usage
	if usage && c.Sample != nil {
		if u, err = c.Sample(); err != nil {
			c.logf("tray: usage sample: %v", err)
			u = nil
		}
	}
	b64 := ""
	if len(shot) > 0 {
		b64 = base64.StdEncoding.EncodeToString(shot)
	}
	return c.API.Support(ctx, user, t, u, b64)
}

// SelfHelp runs one tool for user, after the portal (or, when the portal
// cannot be reached, the cached state and signed pause) says it may.
func (c *Core) SelfHelp(ctx context.Context, user, id string) Result {
	t, ok := Tool(id)
	if !ok {
		return res(OutcomeRefused, "That is not one of the self-help tools.")
	}
	if t.Elevated && !c.Run.Elevated {
		return res(OutcomeRefused, "This tool needs the signed agent.")
	}
	c.mu.Lock()
	c.init()
	c.mu.Unlock()
	if !c.Lim.ToolOK(t) {
		return res(OutcomeRefused, fmt.Sprintf("%q has run too often on this computer. Try again later.", t.Title))
	}
	if t.Elevated && c.SignedPause != nil {
		c.mu.Lock()
		biz := c.business
		c.mu.Unlock()
		msg, err := c.SignedPause(ctx, biz)
		c.mu.Lock()
		if err == nil {
			c.pauseAt, c.pauseMsg = c.now(), msg
		}
		c.mu.Unlock()
		if err == nil && msg != "" {
			return res(OutcomeRefused, "Paused by your IT provider: "+msg)
		}
	}
	runID, err := c.API.Begin(ctx, user, t.ID)
	if err != nil && !Unreachable(err) {
		var ae *APIError
		errors.As(err, &ae)
		return res(OutcomeRefused, ae.Message)
	}
	offline := err != nil
	if offline {
		if why := c.offlineRefusal(user, t); why != "" {
			return res(OutcomeRefused, why)
		}
	}
	c.Lim.RecordTool(t)
	started := c.now()
	r := c.Run.Run(ctx, t.ID)
	rep := RunReport{RunID: runID, Tool: t.ID, RanAt: started, Outcome: r.Outcome, Summary: r.Summary, Lines: r.Lines, User: user}
	if offline {
		c.queue(rep)
		r.Lines = append(r.Lines, "The portal could not be reached; this run will be reported to your IT provider when it can.")
		return r
	}
	if err := c.API.Result(ctx, rep); err != nil {
		if Unreachable(err) {
			// The run is recorded as running at the portal; it is reported
			// as an offline run once the portal answers again.
			rep.RunID = ""
			c.queue(rep)
		} else {
			c.logf("tray: self-help result: %v", err)
		}
	}
	return r
}

// offlineRefusal: an empty string if t may run without the portal. Read-only
// tools always may. An elevated tool may only if the portal answered for
// this user within OfflineGrace and its state did not block the tool, and
// the signed pause was read within OfflineGrace and did not cover actions.
func (c *Core) offlineRefusal(user string, t SelfHelpTool) string {
	if !t.Elevated {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	st, ok := c.lastState[user]
	if !ok || now.Sub(c.lastOK) > OfflineGrace {
		return "The portal cannot be reached and this computer has not heard from it recently, so this tool cannot run now."
	}
	allowed := false
	for _, ts := range st.Tools {
		if ts.ID == t.ID {
			if ts.Blocked != "" {
				return "Paused by your IT provider: " + ts.Blocked
			}
			allowed = true
		}
	}
	if !allowed {
		return "This tool is not available on this computer."
	}
	if c.SignedPause != nil && (c.pauseAt.IsZero() || now.Sub(c.pauseAt) > OfflineGrace || c.pauseMsg != "") {
		return "The portal cannot be reached and the signed containment state could not be confirmed, so this tool cannot run now."
	}
	return ""
}

func (c *Core) queue(r RunReport) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) < 20 {
		c.pending = append(c.pending, r)
	}
}

// FlushPending reports runs made while the portal could not be reached.
// A run older than 7 days is dropped (the portal would refuse it).
func (c *Core) FlushPending(ctx context.Context) {
	c.mu.Lock()
	todo := c.pending
	c.pending = nil
	c.mu.Unlock()
	var keep []RunReport
	for _, r := range todo {
		if c.now().Sub(r.RanAt) > 7*24*time.Hour {
			continue
		}
		r.RunID = ""
		if err := c.API.Result(ctx, r); err != nil {
			if Unreachable(err) {
				keep = append(keep, r)
			} else {
				c.logf("tray: offline result refused: %v", err)
			}
		}
	}
	if len(keep) > 0 {
		c.mu.Lock()
		c.pending = append(keep, c.pending...)
		c.mu.Unlock()
	}
}

// Pending: how many runs are waiting to be reported.
func (c *Core) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending)
}
