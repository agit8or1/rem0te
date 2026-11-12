//go:build windows

package main

// The few Win32 calls the tray makes, by hand: a hidden message window, a
// notification-area icon, a popup menu, two small windows built from
// standard controls, message boxes, and a screen capture. No resource
// script, no cgo.

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	secur32  = windows.NewLazySystemDLL("secur32.dll")

	pRegisterClassExW    = user32.NewProc("RegisterClassExW")
	pCreateWindowExW     = user32.NewProc("CreateWindowExW")
	pDefWindowProcW      = user32.NewProc("DefWindowProcW")
	pDestroyWindow       = user32.NewProc("DestroyWindow")
	pShowWindow          = user32.NewProc("ShowWindow")
	pUpdateWindow        = user32.NewProc("UpdateWindow")
	pGetMessageW         = user32.NewProc("GetMessageW")
	pTranslateMessage    = user32.NewProc("TranslateMessage")
	pDispatchMessageW    = user32.NewProc("DispatchMessageW")
	pIsDialogMessageW    = user32.NewProc("IsDialogMessageW")
	pPostMessageW        = user32.NewProc("PostMessageW")
	pSendMessageW        = user32.NewProc("SendMessageW")
	pPostQuitMessage     = user32.NewProc("PostQuitMessage")
	pCreatePopupMenu     = user32.NewProc("CreatePopupMenu")
	pAppendMenuW         = user32.NewProc("AppendMenuW")
	pDestroyMenu         = user32.NewProc("DestroyMenu")
	pTrackPopupMenu      = user32.NewProc("TrackPopupMenu")
	pGetCursorPos        = user32.NewProc("GetCursorPos")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pMessageBoxW         = user32.NewProc("MessageBoxW")
	pLoadCursorW         = user32.NewProc("LoadCursorW")
	pCreateIconIndirect  = user32.NewProc("CreateIconIndirect")
	pDestroyIcon         = user32.NewProc("DestroyIcon")
	pGetDC               = user32.NewProc("GetDC")
	pReleaseDC           = user32.NewProc("ReleaseDC")
	pGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	pSetWindowTextW      = user32.NewProc("SetWindowTextW")
	pGetWindowTextW      = user32.NewProc("GetWindowTextW")
	pGetWindowTextLength = user32.NewProc("GetWindowTextLengthW")
	pEnableWindow        = user32.NewProc("EnableWindow")
	pFindWindowW         = user32.NewProc("FindWindowW")
	pRegisterWindowMsg   = user32.NewProc("RegisterWindowMessageW")
	pGetClientRect       = user32.NewProc("GetClientRect")
	pSetProcessDPIAware  = user32.NewProc("SetProcessDPIAware")
	pSetFocus            = user32.NewProc("SetFocus")

	pShellNotifyIconW = shell32.NewProc("Shell_NotifyIconW")

	pCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	pCreateDIBSection       = gdi32.NewProc("CreateDIBSection")
	pCreateBitmap           = gdi32.NewProc("CreateBitmap")
	pSelectObject           = gdi32.NewProc("SelectObject")
	pDeleteObject           = gdi32.NewProc("DeleteObject")
	pDeleteDC               = gdi32.NewProc("DeleteDC")
	pBitBlt                 = gdi32.NewProc("BitBlt")
	pGetDIBits              = gdi32.NewProc("GetDIBits")
	pGetStockObject         = gdi32.NewProc("GetStockObject")

	pGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
	pCreateMutexW     = kernel32.NewProc("CreateMutexW")

	pGetUserNameExW = secur32.NewProc("GetUserNameExW")
)

const (
	wmDestroy     = 0x0002
	wmClose       = 0x0010
	wmCommand     = 0x0111
	wmSetFont     = 0x0030
	wmApp         = 0x8000
	wmLButtonUp   = 0x0202
	wmRButtonUp   = 0x0205
	wmContextMenu = 0x007B
	wmSize        = 0x0005
	nimAdd        = 0
	nimModify     = 1
	nimDelete     = 2
	nimSetVersion = 4
	nifMessage    = 0x1
	nifIcon       = 0x2
	nifTip        = 0x4
	nifInfo       = 0x10
	niifInfo      = 0x1
	mfString      = 0x0
	mfGrayed      = 0x1
	mfPopup       = 0x10
	mfSeparator   = 0x800
	tpmRightAlign = 0x8
	tpmBottom     = 0x20
	tpmReturnCmd  = 0x100
	mbOK          = 0x0
	mbYesNo       = 0x4
	mbIconInfo    = 0x40
	mbIconWarn    = 0x30
	mbIconError   = 0x10
	mbTopmost     = 0x40000
	mbSetFg       = 0x10000
	idYes         = 6

	wsOverlapped  = 0x00000000
	wsCaption     = 0x00C00000
	wsSysMenu     = 0x00080000
	wsMinimizeBox = 0x00020000
	wsThickFrame  = 0x00040000
	wsChild       = 0x40000000
	wsVisible     = 0x10000000
	wsTabStop     = 0x00010000
	wsBorder      = 0x00800000
	wsVScroll     = 0x00200000
	wsExTopmost   = 0x00000008
	wsExDlgFrame  = 0x00000001
	esMultiline   = 0x0004
	esAutoVScroll = 0x0040
	esWantReturn  = 0x1000
	bsPushButton  = 0x0
	bsDefPush     = 0x1
	bsAutoCheck   = 0x3
	ssBitmap      = 0x0E
	ssCenterImage = 0x200
	stmSetImage   = 0x0172
	bmGetCheck    = 0x00F0
	bmSetCheck    = 0x00F1
	emLimitText   = 0x00C5
	swShow        = 5
	swHide        = 0
	swShowNormal  = 1
	defaultGUI    = 17
	smCxScreen    = 0
	smCyScreen    = 1
	smXVirtual    = 76
	smYVirtual    = 77
	smCxVirtual   = 78
	smCyVirtual   = 79
	srcCopy       = 0x00CC0020
	captureBlt    = 0x40000000
	nameSamCompat = 2
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type point struct{ X, Y int32 }

type msg struct {
	Hwnd    windows.HWND
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	private uint32
}

type rect struct{ Left, Top, Right, Bottom int32 }

type notifyIconData struct {
	Size            uint32
	Wnd             windows.HWND
	ID              uint32
	Flags           uint32
	CallbackMessage uint32
	Icon            windows.Handle
	Tip             [128]uint16
	State           uint32
	StateMask       uint32
	Info            [256]uint16
	Version         uint32
	InfoTitle       [64]uint16
	InfoFlags       uint32
	GUIDItem        windows.GUID
	BalloonIcon     windows.Handle
}

type iconInfo struct {
	FIcon    int32
	XHotspot uint32
	YHotspot uint32
	Mask     windows.Handle
	Color    windows.Handle
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [1]uint32
}

func u16(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }

func copyU16(dst []uint16, s string) {
	src, _ := windows.UTF16FromString(s)
	if len(src) > len(dst) {
		src = append(src[:len(dst)-1], 0)
	}
	copy(dst, src)
}

func msgBox(owner windows.HWND, text, title string, flags uintptr) int {
	r, _, _ := pMessageBoxW.Call(uintptr(owner), uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(title))), flags|mbSetFg|mbTopmost)
	return int(r)
}

func createWindow(exStyle uint32, class, title string, style uint32, x, y, w, h int32, parent windows.HWND, id uintptr) windows.HWND {
	inst, _, _ := pGetModuleHandleW.Call(0)
	r, _, _ := pCreateWindowExW.Call(uintptr(exStyle), uintptr(unsafe.Pointer(u16(class))), uintptr(unsafe.Pointer(u16(title))), uintptr(style),
		uintptr(x), uintptr(y), uintptr(w), uintptr(h), uintptr(parent), id, inst, 0)
	return windows.HWND(r)
}

func registerClass(name string, proc func(hwnd windows.HWND, m uint32, w, l uintptr) uintptr) error {
	inst, _, _ := pGetModuleHandleW.Call(0)
	cur, _, _ := pLoadCursorW.Call(0, 32512) // IDC_ARROW
	wc := wndClassEx{
		WndProc:    syscall.NewCallback(proc),
		Instance:   windows.Handle(inst),
		Cursor:     windows.Handle(cur),
		Background: windows.Handle(16), // COLOR_BTNFACE + 1
		ClassName:  u16(name),
	}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if r, _, err := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		return err
	}
	return nil
}

func setFont(hwnd windows.HWND) {
	f, _, _ := pGetStockObject.Call(defaultGUI)
	pSendMessageW.Call(uintptr(hwnd), wmSetFont, f, 1)
}

func windowText(hwnd windows.HWND) string {
	n, _, _ := pGetWindowTextLength.Call(uintptr(hwnd))
	buf := make([]uint16, n+1)
	pGetWindowTextW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&buf[0])), n+1)
	return windows.UTF16ToString(buf)
}

func setText(hwnd windows.HWND, s string) {
	pSetWindowTextW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(u16(s))))
}

func enable(hwnd windows.HWND, on bool) {
	v := uintptr(0)
	if on {
		v = 1
	}
	pEnableWindow.Call(uintptr(hwnd), v)
}

func checked(hwnd windows.HWND) bool {
	r, _, _ := pSendMessageW.Call(uintptr(hwnd), bmGetCheck, 0, 0)
	return r == 1
}

func setCheck(hwnd windows.HWND, on bool) {
	v := uintptr(0)
	if on {
		v = 1
	}
	pSendMessageW.Call(uintptr(hwnd), bmSetCheck, v, 0)
}

// samUser is DOMAIN\name for the signed-in user (standard tray only; the
// signed tray's user is the one the host read from the session token).
func samUser() string {
	buf := make([]uint16, 512)
	n := uint32(len(buf))
	if r, _, _ := pGetUserNameExW.Call(nameSamCompat, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

// singleInstance: one tray of each kind per session.
func singleInstance(name string) bool {
	h, _, err := pCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(u16(name))))
	if h == 0 {
		return false
	}
	return err != windows.ERROR_ALREADY_EXISTS
}
