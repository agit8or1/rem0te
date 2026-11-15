//go:build windows

package main

// Loading the generated tray icons (icons.go) on Windows: the image for the
// small-icon size at this DPI, for the taskbar's light or dark theme.

import (
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var pCreateIconFromResourceEx = user32.NewProc("CreateIconFromResourceEx")

const (
	smCxSmIcon      = 49
	wmSettingChange = 0x001A
)

// lightTaskbar: SystemUsesLightTheme (Windows 10 1903+) is the taskbar's
// theme, which is what the notification area is drawn on. Unreadable (older
// Windows, a policy) means dark, the Windows default.
func lightTaskbar() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("SystemUsesLightTheme")
	return err == nil && v == 1
}

// loadTrayIcon makes an HICON for state, or 0 if the embedded file cannot
// be read (it is checked by the tests; this is belt and braces).
func loadTrayIcon(state string, light bool) windows.Handle {
	ico, err := iconFile(state, light)
	if err != nil {
		return 0
	}
	want := 16
	if n, _, _ := pGetSystemMetrics.Call(smCxSmIcon); int(n) > 0 {
		want = int(n)
	}
	img, _, err := pickIconImage(ico, want)
	if err != nil || len(img) == 0 {
		return 0
	}
	// fIcon TRUE, version 0x00030000; the PNG is scaled to the asked size
	// when the file has no exact match.
	h, _, _ := pCreateIconFromResourceEx.Call(uintptr(unsafe.Pointer(&img[0])), uintptr(len(img)), 1, 0x00030000,
		uintptr(want), uintptr(want), 0)
	return windows.Handle(h)
}
