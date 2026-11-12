package tray

import (
	"regexp"
	"sort"
	"time"
)

// Usage is the "include current resource usage" sample, in the shape the
// portal's usageSample() accepts. It holds numbers and process image names
// only — never a command line, a window title or a file name.
type Usage struct {
	SampledAt     string    `json:"sampledAt"`
	CPUPercent    *float64  `json:"cpuPercent,omitempty"`
	MemoryTotalMB *float64  `json:"memoryTotalMb,omitempty"`
	MemoryUsedMB  *float64  `json:"memoryUsedMb,omitempty"`
	DiskTotalMB   *float64  `json:"diskTotalMb,omitempty"`
	DiskFreeMB    *float64  `json:"diskFreeMb,omitempty"`
	UptimeSeconds *float64  `json:"uptimeSeconds,omitempty"`
	TopProcesses  []ProcUse `json:"topProcesses"`
}

type ProcUse struct {
	Name       string  `json:"name"`
	CPUPercent float64 `json:"cpuPercent"`
	MemoryMB   float64 `json:"memoryMb"`
}

var procNameRE = regexp.MustCompile(`^[A-Za-z0-9 ._()+-]{1,64}$`)

// Raw is what a platform sampler reads.
type RawUsage struct {
	CPUPercent, MemTotalMB, MemUsedMB, DiskTotalMB, DiskFreeMB, UptimeSec float64
	Have                                                                  struct{ CPU, Mem, Disk, Uptime bool }
	Procs                                                                 []ProcUse
}

func f(v float64) *float64 { return &v }

// BuildUsage makes a sample from what the platform read: values clamped to
// the portal's ranges, process names that are not an inert image name
// dropped, the ten busiest kept.
func BuildUsage(r RawUsage, now time.Time) *Usage {
	u := &Usage{SampledAt: now.UTC().Format(time.RFC3339)}
	clamp := func(v, hi float64) float64 {
		if v < 0 {
			return 0
		}
		if v > hi {
			return hi
		}
		return v
	}
	if r.Have.CPU {
		u.CPUPercent = f(clamp(r.CPUPercent, 100))
	}
	if r.Have.Mem {
		u.MemoryTotalMB, u.MemoryUsedMB = f(clamp(r.MemTotalMB, 64*1024*1024)), f(clamp(r.MemUsedMB, 64*1024*1024))
	}
	if r.Have.Disk {
		u.DiskTotalMB, u.DiskFreeMB = f(clamp(r.DiskTotalMB, 1024*1024*1024)), f(clamp(r.DiskFreeMB, 1024*1024*1024))
	}
	if r.Have.Uptime {
		u.UptimeSeconds = f(clamp(r.UptimeSec, 20*365*86400))
	}
	var ps []ProcUse
	for _, p := range r.Procs {
		if procNameRE.MatchString(p.Name) {
			ps = append(ps, ProcUse{Name: p.Name, CPUPercent: clamp(p.CPUPercent, 100*256), MemoryMB: clamp(p.MemoryMB, 64*1024*1024)})
		}
	}
	sort.SliceStable(ps, func(i, j int) bool {
		if ps[i].CPUPercent != ps[j].CPUPercent {
			return ps[i].CPUPercent > ps[j].CPUPercent
		}
		return ps[i].MemoryMB > ps[j].MemoryMB
	})
	if len(ps) > 10 {
		ps = ps[:10]
	}
	u.TopProcesses = ps
	if ps == nil {
		u.TopProcesses = []ProcUse{}
	}
	return u
}
