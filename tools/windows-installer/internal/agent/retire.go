package agent

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Retiring the standard agent's leftovers (0.51).
//
// What the standard installer (apps/api/src/public/windows-script.ts, the
// legacy variant) leaves on a computer, by exact name — the only names it has
// ever used:
//
//	Rem0teHeartbeat    scheduled task, every 3 minutes, SYSTEM, running
//	                   C:\ProgramData\Rem0te\heartbeat.ps1. The signed
//	                   install registers the SAME task name with the SAME
//	                   script path (one template, two variants), so the signed
//	                   install already replaces it, and removing it here would
//	                   remove the signed agent's own heartbeat. It is checked,
//	                   not deleted: heartbeat.ps1 must not be the standard
//	                   variant after a signed install.
//	Rem0teEnrollment   scheduled task, every 5 minutes for 24 hours, SYSTEM,
//	                   running retry-enroll.ps1 with enroll.dat — created only
//	                   when an install could not register at once. It sends a
//	                   standard-shaped claim or heartbeat (no channel), which
//	                   is one of the reports that made a signed computer read
//	                   "legacy" (DS-HOME1, DEWEY-WKS2022). Deleted.
//	Rem0teTray         HKLM Run value starting the standard tray
//	                   (`rem0te-tray.exe --standard`). The signed install
//	                   script already removes it; removed again here.
//	tray\tray.json     the standard tray's key file, readable by every user of
//	                   the computer. The signed tray holds no key, and the
//	                   portal refuses a tray key from a signed computer.
//
// Never a wildcard: each name is passed as it is, and the test holds the
// lists to these exact values.

// StandardTasks are the standard agent's scheduled tasks this removes.
var StandardTasks = []string{"Rem0teEnrollment"}

// SharedHeartbeatTask is the heartbeat task both agents register. Never deleted.
const SharedHeartbeatTask = "Rem0teHeartbeat"

// StandardFiles are under the state directory (C:\ProgramData\Rem0te).
var StandardFiles = []string{"retry-enroll.ps1", "enroll.dat", filepath.Join("tray", "tray.json")}

// StandardRunValue is the HKLM ...\CurrentVersion\Run value of the standard tray.
const StandardRunValue = "Rem0teTray"

// StandardHeartbeatMarker is the line only the standard variant of
// heartbeat.ps1 carries (its channelReport slot).
const StandardHeartbeatMarker = "$body['updateChannel'] = 'legacy'"

// RetireOps is what RetireStandard needs from Windows. Every name it is
// handed is one of the constants above.
type RetireOps interface {
	TaskExists(name string) (bool, error)
	DeleteTask(name string) error
	DeleteRunValue(name string) (bool, error)
}

// RetireReport says what was found and removed.
type RetireReport struct {
	Removed []string
	// StandardHeartbeat: heartbeat.ps1 is still the standard variant.
	StandardHeartbeat bool
	Errors            []string
}

// Summary is one line for agent-status.json's lastResult.
func (r RetireReport) Summary() string {
	var parts []string
	if len(r.Removed) > 0 {
		parts = append(parts, "removed standard leftovers: "+strings.Join(r.Removed, ", "))
	}
	if r.StandardHeartbeat {
		parts = append(parts, "heartbeat.ps1 is still the standard heartbeat")
	}
	if len(r.Errors) > 0 {
		parts = append(parts, "could not remove: "+strings.Join(r.Errors, "; "))
	}
	return strings.Join(parts, "; ")
}

// RetireStandard removes the standard agent's leftovers. Safe to run any
// number of times: what is already gone is skipped and not reported.
func RetireStandard(p Paths, ops RetireOps) RetireReport {
	var r RetireReport
	for _, t := range StandardTasks {
		ok, err := ops.TaskExists(t)
		if err != nil {
			r.Errors = append(r.Errors, fmt.Sprintf("task %s: %v", t, err))
			continue
		}
		if !ok {
			continue
		}
		if err := ops.DeleteTask(t); err != nil {
			r.Errors = append(r.Errors, fmt.Sprintf("task %s: %v", t, err))
			continue
		}
		r.Removed = append(r.Removed, "task "+t)
	}
	for _, f := range StandardFiles {
		path := filepath.Join(p.StateDir, f)
		fi, err := os.Lstat(path)
		if err != nil {
			continue
		}
		if !fi.Mode().IsRegular() {
			r.Errors = append(r.Errors, path+": not a regular file; left alone")
			continue
		}
		if err := os.Remove(path); err != nil {
			r.Errors = append(r.Errors, fmt.Sprintf("%s: %v", path, err))
			continue
		}
		r.Removed = append(r.Removed, f)
	}
	if ok, err := ops.DeleteRunValue(StandardRunValue); err != nil {
		r.Errors = append(r.Errors, fmt.Sprintf("Run value %s: %v", StandardRunValue, err))
	} else if ok {
		r.Removed = append(r.Removed, "Run value "+StandardRunValue)
	}
	if raw, err := os.ReadFile(filepath.Join(p.StateDir, "heartbeat.ps1")); err == nil && bytes.Contains(raw, []byte(StandardHeartbeatMarker)) {
		r.StandardHeartbeat = true
	}
	return r
}

// StandardRetirer is implemented by a Platform that can run RetireStandard
// (the Windows one); stage 2 calls it after a successful install.
type StandardRetirer interface {
	RetireOps() RetireOps
}
