package action

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"time"
)

// The signed pause (v0.28): control/pause.json, a TUF target published by
// the release operator with offline keys, exactly like the agent binary and
// approval/keys.json. The portal mirrors it and cannot alter, forge or
// silently drop it — withholding a newer one only works until the signed
// timestamp expires, after which the agent refuses everything.
//
// It is the layer of containment a compromised portal cannot lift: an agent
// that sees itself paused refuses approved actions (and, for updates, the
// update command) whatever the portal delivers.
//
// To lift it, publish a new pause.json that pauses nothing.

const (
	PauseTarget = "control/pause.json"
	PauseSchema = "rem0te-pause/1"
	maxPauseIDs = 5000
)

type PauseScope struct {
	All        bool     `json:"all"`
	Businesses []string `json:"businesses,omitempty"`
	Computers  []string `json:"computers,omitempty"` // RustDesk IDs
}

type Pause struct {
	Schema   string     `json:"schema"`
	IssuedAt string     `json:"issuedAt"`
	Reason   string     `json:"reason"`
	Actions  PauseScope `json:"actions"`
	Updates  PauseScope `json:"updates"`
}

var (
	pauseBizRE = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	pauseRidRE = regexp.MustCompile(`^[0-9]{6,12}$`)
)

// ParsePause is strict: an unknown field, a bad id or an oversized list is
// refused whole, and so is a pause file the agent cannot read — the caller
// then treats actions as paused (fail closed).
func ParsePause(raw []byte) (*Pause, error) {
	var p Pause
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return nil, err
	}
	if d.More() {
		return nil, errors.New("trailing data")
	}
	if p.Schema != PauseSchema {
		return nil, errors.New("pause: schema must be " + PauseSchema)
	}
	if _, err := time.Parse(time.RFC3339, p.IssuedAt); err != nil {
		return nil, errors.New("pause: issuedAt must be RFC 3339")
	}
	if len(p.Reason) > 300 {
		return nil, errors.New("pause: reason longer than 300")
	}
	if len(p.Updates.Businesses) > 0 || len(p.Updates.Computers) > 0 {
		// The update command runs before the agent knows which business or
		// RustDesk ID it serves, so a narrower updates pause would be a
		// promise it cannot keep.
		return nil, errors.New("pause: updates are paused for all computers or none")
	}
	for _, s := range []PauseScope{p.Actions, p.Updates} {
		if len(s.Businesses) > maxPauseIDs || len(s.Computers) > maxPauseIDs {
			return nil, errors.New("pause: too many ids")
		}
		for _, b := range s.Businesses {
			if !pauseBizRE.MatchString(b) {
				return nil, errors.New("pause: bad business id")
			}
		}
		for _, c := range s.Computers {
			if !pauseRidRE.MatchString(c) {
				return nil, errors.New("pause: bad RustDesk id")
			}
		}
	}
	return &p, nil
}

func (s PauseScope) covers(businessID, rustdeskID string) bool {
	if s.All {
		return true
	}
	for _, b := range s.Businesses {
		if businessID != "" && b == businessID {
			return true
		}
	}
	for _, c := range s.Computers {
		if rustdeskID != "" && c == rustdeskID {
			return true
		}
	}
	return false
}

// ActionsPaused: does this pause stop an action for this business / computer?
func (p *Pause) ActionsPaused(businessID, rustdeskID string) bool {
	return p != nil && p.Actions.covers(businessID, rustdeskID)
}

// UpdatesPaused: does this pause stop the update command?
func (p *Pause) UpdatesPaused() bool { return p != nil && p.Updates.All }
