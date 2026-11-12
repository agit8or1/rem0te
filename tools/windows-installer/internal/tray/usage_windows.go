//go:build windows

package tray

import (
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	k32                  = windows.NewLazySystemDLL("kernel32.dll")
	pGlobalMemoryStatus  = k32.NewProc("GlobalMemoryStatusEx")
	pGetSystemTimes      = k32.NewProc("GetSystemTimes")
	pGetTickCount64      = k32.NewProc("GetTickCount64")
	pGetProcessMemoryInf = k32.NewProc("K32GetProcessMemoryInfo")
)

type memStatusEx struct {
	Length, MemoryLoad                     uint32
	TotalPhys, AvailPhys, TotalPageFile    uint64
	AvailPageFile, TotalVirtual, AvailVirt uint64
	AvailExtendedVirtual                   uint64
}

type procMemCounters struct {
	CB                                                 uint32
	PageFaultCount                                     uint32
	PeakWorkingSetSize, WorkingSetSize                 uintptr
	QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage       uintptr
	QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage uintptr
	PagefileUsage, PeakPagefileUsage                   uintptr
}

func ft(f windows.Filetime) uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }

func systemTimes() (idle, total uint64, ok bool) {
	var i, k, u windows.Filetime
	r, _, _ := pGetSystemTimes.Call(uintptr(unsafe.Pointer(&i)), uintptr(unsafe.Pointer(&k)), uintptr(unsafe.Pointer(&u)))
	if r == 0 {
		return 0, 0, false
	}
	return ft(i), ft(k) + ft(u), true
}

type procSample struct {
	name string
	cpu  uint64
	mem  uint64
}

// processes: image name (never the command line), CPU time and working set.
// A process this account cannot open is skipped.
func processes() map[uint32]procSample {
	out := map[uint32]procSample{}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return out
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		h, oerr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID)
		if oerr != nil {
			continue
		}
		var c, x, k, u windows.Filetime
		s := procSample{name: windows.UTF16ToString(e.ExeFile[:])}
		if windows.GetProcessTimes(h, &c, &x, &k, &u) == nil {
			s.cpu = ft(k) + ft(u)
		}
		var pm procMemCounters
		pm.CB = uint32(unsafe.Sizeof(pm))
		if r, _, _ := pGetProcessMemoryInf.Call(uintptr(h), uintptr(unsafe.Pointer(&pm)), uintptr(pm.CB)); r != 0 {
			s.mem = uint64(pm.WorkingSetSize)
		}
		windows.CloseHandle(h)
		out[e.ProcessID] = s
	}
	return out
}

// SampleUsage reads CPU over one second, memory, the system drive and
// uptime, and the ten busiest processes by image name.
func SampleUsage() (*Usage, error) {
	var raw RawUsage
	i0, t0, ok0 := systemTimes()
	p0 := processes()
	time.Sleep(time.Second)
	i1, t1, ok1 := systemTimes()
	p1 := processes()
	if ok0 && ok1 && t1 > t0 {
		raw.CPUPercent = 100 * float64((t1-t0)-(i1-i0)) / float64(t1-t0)
		raw.Have.CPU = true
		wall := t1 - t0 // 100 ns units, every core together: a process's share of the whole machine
		for pid, b := range p1 {
			a, ok := p0[pid]
			if !ok || a.name != b.name || b.cpu < a.cpu {
				continue
			}
			raw.Procs = append(raw.Procs, ProcUse{Name: b.name, CPUPercent: 100 * float64(b.cpu-a.cpu) / float64(wall), MemoryMB: float64(b.mem) / (1 << 20)})
		}
	}
	var ms memStatusEx
	ms.Length = uint32(unsafe.Sizeof(ms))
	if r, _, _ := pGlobalMemoryStatus.Call(uintptr(unsafe.Pointer(&ms))); r != 0 {
		raw.MemTotalMB, raw.MemUsedMB, raw.Have.Mem = float64(ms.TotalPhys)/(1<<20), float64(ms.TotalPhys-ms.AvailPhys)/(1<<20), true
	}
	drive := filepath.VolumeName(os.Getenv("SystemRoot")) + `\`
	if !strings.HasSuffix(drive, `:\`) {
		drive = `C:\`
	}
	var free, total, totalFree uint64
	if windows.GetDiskFreeSpaceEx(windows.StringToUTF16Ptr(drive), &free, &total, &totalFree) == nil {
		raw.DiskTotalMB, raw.DiskFreeMB, raw.Have.Disk = float64(total)/(1<<20), float64(totalFree)/(1<<20), true
	}
	if r, _, _ := pGetTickCount64.Call(); r != 0 {
		raw.UptimeSec, raw.Have.Uptime = float64(r)/1000, true
	}
	return BuildUsage(raw, time.Now()), nil
}
