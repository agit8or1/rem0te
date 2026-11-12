package tray

import (
	"sync"
	"time"
)

// Limits is a set of sliding-window counters by key: "tool:dns.check",
// "support:device", "support:user:DOMAIN\name". The portal enforces the same
// numbers and is the authority; this stops a stuck menu or a looping script
// in the session before it reaches the network, and holds when the portal
// cannot be reached (the offline self-help case).
type Limits struct {
	mu   sync.Mutex
	Now  func() time.Time
	seen map[string][]time.Time
}

func NewLimits() *Limits { return &Limits{Now: time.Now, seen: map[string][]time.Time{}} }

// Allow records one more for key and allows it, or refuses it, if fewer than
// n have been recorded in the last window.
func (l *Limits) Allow(key string, n int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	keep := l.seen[key][:0]
	for _, t := range l.seen[key] {
		if now.Sub(t) < window {
			keep = append(keep, t)
		}
	}
	if len(keep) >= n {
		l.seen[key] = keep
		return false
	}
	l.seen[key] = append(keep, now)
	return true
}

// AllowTool applies a tool's own window and the hourly cap on every tool,
// and records the run if it is allowed.
func (l *Limits) AllowTool(t SelfHelpTool) bool { return l.tool(t, true) }

// ToolOK checks the same limits without recording anything: the run is
// recorded (RecordTool) only once it is going to happen, so a run refused by
// the portal — for containment, say — does not use up the allowance, the
// same rule the portal counts by (refused runs are not counted).
func (l *Limits) ToolOK(t SelfHelpTool) bool { return l.tool(t, false) }

// RecordTool records a run that is going ahead.
func (l *Limits) RecordTool(t SelfHelpTool) {
	l.mu.Lock()
	now := l.Now()
	l.seen["tool:"+t.ID] = append(l.seen["tool:"+t.ID], now)
	l.seen["tool:*"] = append(l.seen["tool:*"], now)
	l.mu.Unlock()
}

func (l *Limits) tool(t SelfHelpTool, record bool) bool {
	l.mu.Lock()
	now := l.Now()
	count := func(key string, window time.Duration) int {
		keep := l.seen[key][:0]
		for _, at := range l.seen[key] {
			if now.Sub(at) < window {
				keep = append(keep, at)
			}
		}
		l.seen[key] = keep
		return len(keep)
	}
	ok := count("tool:"+t.ID, t.Window) < t.PerWindow && count("tool:*", time.Hour) < PerHour
	if ok && record {
		l.seen["tool:"+t.ID] = append(l.seen["tool:"+t.ID], now)
		l.seen["tool:*"] = append(l.seen["tool:*"], now)
	}
	l.mu.Unlock()
	return ok
}

// Support request limits (SUPPORT_PER_DEVICE_HOUR / SUPPORT_PER_USER_HOUR).
const (
	SupportPerDeviceHour = 3
	SupportPerUserHour   = 2
)

// AllowSupport applies both support-request limits; a refusal uses up neither.
func (l *Limits) AllowSupport(user string) bool {
	l.mu.Lock()
	now := l.Now()
	n := func(key string) int {
		keep := l.seen[key][:0]
		for _, at := range l.seen[key] {
			if now.Sub(at) < time.Hour {
				keep = append(keep, at)
			}
		}
		l.seen[key] = keep
		return len(keep)
	}
	ok := n("support:device") < SupportPerDeviceHour && n("support:user:"+user) < SupportPerUserHour
	if ok {
		l.seen["support:device"] = append(l.seen["support:device"], now)
		l.seen["support:user:"+user] = append(l.seen["support:user:"+user], now)
	}
	l.mu.Unlock()
	return ok
}
