//go:build windows

package main

// `rem0te-agent.exe chat-window --down PIPE --up PIPE --nonce HEX` (0.34):
// the chat window, started by the chat host in the signed-in user's session
// with that user's own token. It runs unprivileged, holds no device secret
// and opens no network connection: it reads frames from one pipe and writes
// frames to the other, and nothing else.
//
// Plain Win32 controls on purpose. The transcript is a read-only edit
// control, which displays text and nothing else — no HTML, no markup, no
// link detection — so nothing a message says can be clicked, run or opened.
// The title, the banner and every line say which business and which
// technician the chat is with.

import (
	"errors"
	"flag"
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/chat"
)

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")

	pRegisterClassEx  = user32.NewProc("RegisterClassExW")
	pCreateWindowEx   = user32.NewProc("CreateWindowExW")
	pDefWindowProc    = user32.NewProc("DefWindowProcW")
	pGetMessage       = user32.NewProc("GetMessageW")
	pTranslateMessage = user32.NewProc("TranslateMessage")
	pDispatchMessage  = user32.NewProc("DispatchMessageW")
	pIsDialogMessage  = user32.NewProc("IsDialogMessageW")
	pPostMessage      = user32.NewProc("PostMessageW")
	pSendMessage      = user32.NewProc("SendMessageW")
	pShowWindow       = user32.NewProc("ShowWindow")
	pMoveWindow       = user32.NewProc("MoveWindow")
	pSetWindowText    = user32.NewProc("SetWindowTextW")
	pGetWindowText    = user32.NewProc("GetWindowTextW")
	pGetWindowTextLen = user32.NewProc("GetWindowTextLengthW")
	pEnableWindow     = user32.NewProc("EnableWindow")
	pDestroyWindow    = user32.NewProc("DestroyWindow")
	pPostQuitMessage  = user32.NewProc("PostQuitMessage")
	pGetForegroundWnd = user32.NewProc("GetForegroundWindow")
	pSetForegroundWnd = user32.NewProc("SetForegroundWindow")
	pIsIconic         = user32.NewProc("IsIconic")
	pIsWindowVisible  = user32.NewProc("IsWindowVisible")
	pFlashWindowEx    = user32.NewProc("FlashWindowEx")
	pLoadCursor       = user32.NewProc("LoadCursorW")
	pGetClientRect    = user32.NewProc("GetClientRect")
	pSetFocus         = user32.NewProc("SetFocus")
	pGetStockObject   = gdi32.NewProc("GetStockObject")
)

const (
	wsOverlappedWindow = 0x00CF0000
	wsVisible          = 0x10000000
	wsChild            = 0x40000000
	wsVScroll          = 0x00200000
	wsTabStop          = 0x00010000
	wsExClientEdge     = 0x00000200
	esMultiline        = 0x0004
	esAutoVScroll      = 0x0040
	esReadOnly         = 0x0800
	bsDefPushButton    = 0x0001
	ssNoPrefix         = 0x0080

	wmCreate    = 0x0001
	wmDestroy   = 0x0002
	wmSize      = 0x0005
	wmActivate  = 0x0006
	wmSetFont   = 0x0030
	wmClose     = 0x0010
	wmCommand   = 0x0111
	wmApp       = 0x8000
	wmAppFrames = wmApp + 1
	wmAppGone   = wmApp + 2

	emSetSel      = 0x00B1
	emScrollCaret = 0x00B7
	emLimitText   = 0x00C5

	idSend      = 1 // IDOK: Enter in the message box presses Send
	idInput     = 101
	idLog       = 102
	idBanner    = 103
	idStatus    = 104
	swShow      = 5
	cwUseDef    = 0x80000000
	idcArrow    = 32512
	colorBtn    = 15
	defaultFont = 17
	flashAll    = 0x3
	flashNoFg   = 0xC
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

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

type rect struct{ Left, Top, Right, Bottom int32 }

type flashInfo struct {
	Size    uint32
	Hwnd    uintptr
	Flags   uint32
	Count   uint32
	Timeout uint32
}

func u16(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }

// The window's state, owned by the UI thread except where it says.
type chatWindow struct {
	hwnd, banner, log, input, send, status uintptr
	font                                   uintptr
	tr                                     *chat.Transcript
	out                                    *os.File
	gone                                   bool

	mu     sync.Mutex // guards queue: the reader goroutine fills it, the UI thread drains it
	queue  []chat.Frame
	failed error
}

var theWindow *chatWindow

func cmdChatWindow(args []string) int {
	fs := flag.NewFlagSet("chat-window", flag.ContinueOnError)
	down := fs.String("down", "", "pipe the host writes")
	up := fs.String("up", "", "pipe the host reads")
	nonce := fs.String("nonce", "", "this launch's nonce")
	if err := fs.Parse(args); err != nil || !chat.ValidPipeName(*down) || !chat.ValidPipeName(*up) || !chat.ValidNonce(*nonce) {
		return 2
	}
	// SECURITY_IDENTIFICATION: the pipe's server may learn who connected,
	// never act as them.
	open := func(name string, access uint32) (*os.File, error) {
		h, err := windows.CreateFile(u16(name), access, 0, nil, windows.OPEN_EXISTING, windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IDENTIFICATION, 0)
		if err != nil {
			return nil, err
		}
		return os.NewFile(uintptr(h), name), nil
	}
	in, err := open(*down, windows.GENERIC_READ)
	if err != nil {
		return 3
	}
	out, err := open(*up, windows.GENERIC_WRITE)
	if err != nil {
		return 3
	}
	if err := chat.WriteFrame(out, chat.Frame{T: chat.FrameHello, Nonce: *nonce}); err != nil {
		return 3
	}
	w := &chatWindow{tr: chat.NewTranscript(), out: out}
	theWindow = w
	if err := w.create(); err != nil {
		return 4
	}
	go w.readHost(in)
	return w.loop()
}

// readHost runs on its own goroutine: frames from the host are checked, then
// queued for the UI thread, which is woken with a posted message.
func (w *chatWindow) readHost(in *os.File) {
	r := chat.NewReader(in)
	for {
		f, err := r.Next()
		if err == nil {
			f, err = chat.CheckFromHost(f)
		}
		if err != nil {
			w.mu.Lock()
			w.failed = err
			w.mu.Unlock()
			pPostMessage.Call(w.hwnd, wmAppGone, 0, 0)
			return
		}
		w.mu.Lock()
		w.queue = append(w.queue, f)
		w.mu.Unlock()
		pPostMessage.Call(w.hwnd, wmAppFrames, 0, 0)
	}
}

func (w *chatWindow) create() error {
	cls := u16("Rem0teSupportChat")
	cursor, _, _ := pLoadCursor.Call(0, idcArrow)
	wc := wndClassEx{WndProc: windows.NewCallback(wndProc), Cursor: windows.Handle(cursor), Background: windows.Handle(colorBtn + 1), ClassName: cls}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if r, _, err := pRegisterClassEx.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		return err
	}
	h, _, err := pCreateWindowEx.Call(0, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(u16(w.tr.Title()))),
		wsOverlappedWindow|wsVisible, cwUseDef, cwUseDef, 460, 560, 0, 0, 0, 0)
	if h == 0 {
		return err
	}
	w.hwnd = h
	pShowWindow.Call(h, swShow)
	pSetForegroundWnd.Call(h)
	return nil
}

func (w *chatWindow) child(class string, style uintptr, ex uintptr, id uintptr) uintptr {
	h, _, _ := pCreateWindowEx.Call(ex, uintptr(unsafe.Pointer(u16(class))), 0, wsChild|wsVisible|style, 0, 0, 10, 10, w.hwnd, id, 0, 0)
	pSendMessage.Call(h, wmSetFont, w.font, 1)
	return h
}

func (w *chatWindow) onCreate(hwnd uintptr) {
	w.hwnd = hwnd
	w.font, _, _ = pGetStockObject.Call(defaultFont)
	w.banner = w.child("STATIC", ssNoPrefix, 0, idBanner)
	w.log = w.child("EDIT", esMultiline|esReadOnly|esAutoVScroll|wsVScroll, wsExClientEdge, idLog)
	pSendMessage.Call(w.log, emLimitText, 0, 0)
	w.input = w.child("EDIT", esMultiline|esAutoVScroll|wsVScroll|wsTabStop, wsExClientEdge, idInput)
	pSendMessage.Call(w.input, emLimitText, chat.MaxMessageChars, 0)
	w.send = w.child("BUTTON", bsDefPushButton|wsTabStop, 0, idSend)
	setText(w.send, "Send")
	w.status = w.child("STATIC", ssNoPrefix, 0, idStatus)
	setText(w.status, "Enter sends. Ctrl+Enter starts a new line.")
	w.redraw()
	pSetFocus.Call(w.input)
}

func setText(h uintptr, s string) { pSetWindowText.Call(h, uintptr(unsafe.Pointer(u16(s)))) }

func (w *chatWindow) layout() {
	var r rect
	pGetClientRect.Call(w.hwnd, uintptr(unsafe.Pointer(&r)))
	wd, ht := r.Right-r.Left, r.Bottom-r.Top
	const pad, bannerH, inputH, statusH, btnW = 8, 56, 64, 20, 80
	move := func(h uintptr, x, y, cx, cy int32) {
		pMoveWindow.Call(h, uintptr(x), uintptr(y), uintptr(max(cx, 1)), uintptr(max(cy, 1)), 1)
	}
	move(w.banner, pad, pad, wd-2*pad, bannerH)
	logH := ht - bannerH - inputH - statusH - 5*pad
	move(w.log, pad, 2*pad+bannerH, wd-2*pad, logH)
	move(w.input, pad, 3*pad+bannerH+logH, wd-3*pad-btnW, inputH)
	move(w.send, wd-pad-btnW, 3*pad+bannerH+logH, btnW, inputH)
	move(w.status, pad, 4*pad+bannerH+logH+inputH, wd-2*pad, statusH)
}

func (w *chatWindow) redraw() {
	setText(w.hwnd, w.tr.Title())
	setText(w.banner, w.tr.Banner())
	setText(w.log, w.tr.Render())
	pSendMessage.Call(w.log, emSetSel, 0x7FFFFFFF, 0x7FFFFFFF)
	pSendMessage.Call(w.log, emScrollCaret, 0, 0)
	if w.tr.Ended || w.gone {
		pEnableWindow.Call(w.input, 0)
		pEnableWindow.Call(w.send, 0)
	}
}

// acks reports what is on screen now: shown if the window is not minimised,
// read if it is also in front. The transcript sends each id once.
func (w *chatWindow) acks() {
	if w.gone {
		return
	}
	iconic, _, _ := pIsIconic.Call(w.hwnd)
	visible, _, _ := pIsWindowVisible.Call(w.hwnd)
	fg, _, _ := pGetForegroundWnd.Call()
	shown, read := w.tr.Acks(visible != 0 && iconic == 0, fg == w.hwnd)
	for _, x := range []struct {
		t   string
		ids []string
	}{{chat.FrameShown, shown}, {chat.FrameRead, read}} {
		for len(x.ids) > 0 {
			n := min(len(x.ids), 100)
			_ = chat.WriteFrame(w.out, chat.Frame{T: x.t, IDs: x.ids[:n]})
			x.ids = x.ids[n:]
		}
	}
}

func (w *chatWindow) onFrames() {
	w.mu.Lock()
	q := w.queue
	w.queue = nil
	w.mu.Unlock()
	changed, fromTech := false, false
	for _, f := range q {
		if w.tr.Apply(f) {
			changed = true
			if f.T == chat.FrameMsg && f.From == "technician" {
				fromTech = true
			}
		}
	}
	if !changed {
		return
	}
	w.redraw()
	if w.tr.Ended {
		setText(w.status, w.tr.EndText())
	}
	if fromTech {
		fi := flashInfo{Hwnd: w.hwnd, Flags: flashAll | flashNoFg}
		fi.Size = uint32(unsafe.Sizeof(fi))
		pFlashWindowEx.Call(uintptr(unsafe.Pointer(&fi)))
	}
	w.acks()
}

func (w *chatWindow) onSend() {
	if w.gone || w.tr.Ended {
		return
	}
	n, _, _ := pGetWindowTextLen.Call(w.input)
	buf := make([]uint16, n+1)
	pGetWindowText.Call(w.input, uintptr(unsafe.Pointer(&buf[0])), n+1)
	text, err := chat.CleanText(windows.UTF16ToString(buf))
	if errors.Is(err, chat.ErrEmpty) {
		return
	}
	if err != nil {
		setText(w.status, "A message can be at most 2,000 characters.")
		return
	}
	cid := chat.NewCID()
	if err := chat.WriteFrame(w.out, chat.Frame{T: chat.FrameSend, CID: cid, Text: text}); err != nil {
		w.onGone()
		return
	}
	w.tr.Local(cid, text)
	setText(w.input, "")
	setText(w.status, "Enter sends. Ctrl+Enter starts a new line.")
	w.redraw()
}

func (w *chatWindow) onGone() {
	if w.gone {
		return
	}
	w.gone = true
	if !w.tr.Ended {
		setText(w.status, "Disconnected from the support agent. Messages can no longer be sent from this window.")
	}
	w.redraw()
}

func wndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	w := theWindow
	switch msg {
	case wmCreate:
		w.onCreate(hwnd)
		return 0
	case wmSize:
		if w.log != 0 {
			w.layout()
			w.acks()
		}
		return 0
	case wmActivate:
		if w.log != 0 && wparam&0xFFFF != 0 {
			w.acks()
		}
	case wmCommand:
		if wparam&0xFFFF == idSend && (wparam>>16)&0xFFFF == 0 {
			w.onSend()
			return 0
		}
	case wmAppFrames:
		w.onFrames()
		return 0
	case wmAppGone:
		w.onGone()
		return 0
	case wmClose:
		// The person closed it: say so, so the portal shows the chat as
		// closed by them instead of waiting on a window nobody can see.
		if !w.gone && !w.tr.Ended {
			_ = chat.WriteFrame(w.out, chat.Frame{T: chat.FrameClose})
		}
		pDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProc.Call(hwnd, msg, wparam, lparam)
	return r
}

func (w *chatWindow) loop() int {
	var m winMsg
	for {
		r, _, _ := pGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		// Tab between controls, Enter for Send.
		if d, _, _ := pIsDialogMessage.Call(w.hwnd, uintptr(unsafe.Pointer(&m))); d != 0 {
			continue
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
	_ = w.out.Close()
	return 0
}
