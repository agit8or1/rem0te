//go:build windows

package main

import (
	"context"
	"fmt"
	"image"
	"image/color"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/agit8or1/rem0te/windows-installer/internal/tray"
)

// buildVersion may be set at link time (-X main.buildVersion=0.36.0).
var buildVersion string

const (
	trayDir     = `C:\ProgramData\Rem0te\tray`
	appClass    = "Rem0teTrayApp"
	chatClass   = "Rem0teChatWindow"
	wmTrayIcon  = wmApp + 1
	wmNewState  = wmApp + 2
	wmRunUI     = wmApp + 3
	idChat      = 100
	idSupport   = 101
	idAbout     = 102
	idToolBase  = 200
	tooltipBase = "Support"
)

func main() {
	runtime.LockOSThread()
	o, err := parseArgs(os.Args[1:])
	if err != nil {
		os.Exit(2)
	}
	pSetProcessDPIAware.Call()
	switch o.mode {
	case modeChatWindow:
		os.Exit(runChatWindow(o.portal))
	case modeSigned:
		os.Exit(runSigned(o))
	case modeStandard:
		os.Exit(runStandard())
	}
}

func runSigned(o options) int {
	// Pipes made by the host: down is read-only to us, up write-only.
	down, err := os.OpenFile(o.down, os.O_RDONLY, 0)
	if err != nil {
		return 4
	}
	up, err := os.OpenFile(o.up, os.O_WRONLY, 0)
	if err != nil {
		down.Close()
		return 4
	}
	b, err := tray.NewPipeBackend(down, up, o.nonce, func() { down.Close(); up.Close() })
	if err != nil {
		return 4
	}
	a := &app{backend: b, portalFromState: true}
	go func() {
		<-b.Gone()
		// The host let go (the agent stopped or is being updated). It starts
		// a new tray when it is back; this one leaves.
		a.post(wmClose)
	}()
	return a.run()
}

func runStandard() int {
	if !singleInstance(`Local\Rem0teTrayStandard`) {
		return 0
	}
	var tf trayFile
	// The heartbeat pairs the tray within a beat or two of installing it.
	for {
		raw, err := os.ReadFile(filepath.Join(trayDir, "tray.json"))
		if err == nil {
			if tf, err = parseTrayFile(raw); err == nil {
				break
			}
		}
		time.Sleep(time.Minute)
	}
	version := "standard agent"
	if buildVersion != "" {
		version = buildVersion
	}
	core := &tray.Core{
		API:     &tray.Client{Base: "https://" + tf.Portal + "/api/v1", Cred: tray.Credential{TrayKey: tf.TrayKey}},
		Portal:  tf.Portal,
		Agent:   "standard",
		Version: version,
		Run:     &tray.Runner{OS: tray.WinOS{}, Portal: tf.Portal, Elevated: false},
		Sample:  tray.SampleUsage,
	}
	b := tray.NewLocalBackend(core, samUser())
	a := &app{backend: b, portal: tf.Portal}
	go watchSignal(b)
	return a.run()
}

// watchSignal: the heartbeat writes signal.json when a chat opens or closes;
// the standard tray then asks the portal at once instead of at its next poll.
func watchSignal(b tray.Backend) {
	var last time.Time
	for {
		if st, err := os.Stat(filepath.Join(trayDir, "signal.json")); err == nil && !st.ModTime().Equal(last) {
			last = st.ModTime()
			b.Kick()
		}
		time.Sleep(10 * time.Second)
	}
}

// ── The app ─────────────────────────────────────────────────────────────────

type app struct {
	backend         tray.Backend
	portal          string
	portalFromState bool
	hwnd            windows.HWND
	icon            windows.Handle
	iconBadge       bool
	added           bool

	mu          sync.Mutex
	state       tray.State
	haveState   bool
	ui          []func()
	autoOpened  map[string]bool
	shownUnread map[string]bool
	chatCmd     *exec.Cmd
	busyTool    bool
	support     *supportForm
}

var theApp *app

func (a *app) post(m uint32) { pPostMessageW.Call(uintptr(a.hwnd), uintptr(m), 0, 0) }

// onUI runs f on the window thread.
func (a *app) onUI(f func()) {
	a.mu.Lock()
	a.ui = append(a.ui, f)
	a.mu.Unlock()
	a.post(wmRunUI)
}

func (a *app) run() int {
	theApp = a
	a.autoOpened, a.shownUnread = map[string]bool{}, map[string]bool{}
	if err := registerClass(appClass, appProc); err != nil {
		return 5
	}
	if err := registerSupportClass(); err != nil {
		return 5
	}
	a.hwnd = createWindow(0, appClass, "Rem0te tray", 0, 0, 0, 0, 0, 0, 0)
	if a.hwnd == 0 {
		return 5
	}
	a.setIcon("#3B82F6", false, "Connecting to your IT provider…")
	a.backend.Start(func(s tray.State) {
		a.mu.Lock()
		a.state, a.haveState = s, true
		a.mu.Unlock()
		a.post(wmNewState)
	})
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		if a.support != nil && a.support.hwnd != 0 {
			if d, _, _ := pIsDialogMessageW.Call(uintptr(a.support.hwnd), uintptr(unsafe.Pointer(&m))); d != 0 {
				continue
			}
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	a.removeIcon()
	a.backend.Close()
	return 0
}

func appProc(hwnd windows.HWND, m uint32, w, l uintptr) uintptr {
	a := theApp
	switch m {
	case wmTrayIcon:
		switch uint32(l & 0xffff) {
		case wmLButtonUp, wmRButtonUp, wmContextMenu:
			a.showMenu()
		}
		return 0
	case wmNewState:
		a.applyState()
		return 0
	case wmRunUI:
		a.mu.Lock()
		todo := a.ui
		a.ui = nil
		a.mu.Unlock()
		for _, f := range todo {
			f()
		}
		return 0
	case wmClose:
		pDestroyWindow.Call(uintptr(hwnd))
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(uintptr(hwnd), uintptr(m), w, l)
	return r
}

func (a *app) snapshot() (tray.State, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state, a.haveState
}

// applyState redraws the icon and tooltip, says when a technician writes,
// reports what it showed, and opens a technician's new chat in the console
// session once.
func (a *app) applyState() {
	s, _ := a.snapshot()
	if a.portalFromState && tray.ValidPortal(s.Portal) {
		a.portal = s.Portal
	}
	tip := "Support"
	if s.Business != "" {
		tip = "Support for " + s.Business
	}
	if s.Offline {
		tip += " (offline)"
	}
	unread := len(s.Chat.Unread)
	if unread > 0 {
		tip += fmt.Sprintf(" — %d new message(s)", unread)
	}
	a.setIcon(s.Accent, unread > 0, tip)
	var fresh []string
	for _, id := range s.Chat.Unread {
		if !a.shownUnread[id] {
			a.shownUnread[id] = true
			fresh = append(fresh, id)
		}
	}
	if len(fresh) > 0 {
		a.balloon("New message from support", "Choose Chat with support to read and reply.")
		a.backend.Seen(fresh)
	}
	if s.Chat.AutoOpen && s.Chat.ConversationID != "" && !a.autoOpened[s.Chat.ConversationID] && !a.chatOpen() {
		a.autoOpened[s.Chat.ConversationID] = true
		a.openChat()
	}
}

// ── Icon ────────────────────────────────────────────────────────────────────

func parseHex(s string) color.RGBA {
	var r, g, b uint8
	if len(s) == 7 {
		fmt.Sscanf(s[1:], "%02x%02x%02x", &r, &g, &b)
		return color.RGBA{r, g, b, 255}
	}
	return color.RGBA{0x3B, 0x82, 0xF6, 255}
}

// makeIcon draws the tray icon: a filled circle in the business's accent
// colour with a white speech mark, and a red dot when there is something unread.
func makeIcon(accent string, badge bool) windows.Handle {
	const n = 32
	img := image.NewRGBA(image.Rect(0, 0, n, n))
	c := parseHex(accent)
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			dx, dy := float64(x)-15.5, float64(y)-15.5
			switch {
			case dx*dx+dy*dy <= 15*15:
				img.Set(x, y, c)
				if x >= 9 && x <= 22 && y >= 10 && y <= 18 || x >= 11 && x <= 13 && y > 18 && y <= 22 {
					img.Set(x, y, color.RGBA{255, 255, 255, 255})
				}
			}
			if badge {
				bx, by := float64(x)-25, float64(y)-6
				if bx*bx+by*by <= 6*6 {
					img.Set(x, y, color.RGBA{220, 38, 38, 255})
				}
			}
		}
	}
	bi := bitmapInfo{Header: bitmapInfoHeader{Width: n, Height: -n, Planes: 1, BitCount: 32}}
	bi.Header.Size = uint32(unsafe.Sizeof(bi.Header))
	var bits unsafe.Pointer
	hdc, _, _ := pGetDC.Call(0)
	hbm, _, _ := pCreateDIBSection.Call(hdc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	pReleaseDC.Call(0, hdc)
	if hbm == 0 {
		return 0
	}
	px := unsafe.Slice((*byte)(bits), n*n*4)
	for i := 0; i < n*n; i++ {
		r, g, b, al := img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3]
		px[i*4], px[i*4+1], px[i*4+2], px[i*4+3] = b, g, r, al
	}
	mask, _, _ := pCreateBitmap.Call(n, n, 1, 1, 0)
	ii := iconInfo{FIcon: 1, Mask: windows.Handle(mask), Color: windows.Handle(hbm)}
	h, _, _ := pCreateIconIndirect.Call(uintptr(unsafe.Pointer(&ii)))
	pDeleteObject.Call(hbm)
	pDeleteObject.Call(mask)
	return windows.Handle(h)
}

func (a *app) iconData() notifyIconData {
	d := notifyIconData{Wnd: a.hwnd, ID: 1}
	d.Size = uint32(unsafe.Sizeof(d))
	return d
}

func (a *app) setIcon(accent string, badge bool, tip string) {
	old := a.icon
	a.icon = makeIcon(accent, badge)
	d := a.iconData()
	d.Flags = nifMessage | nifIcon | nifTip
	d.CallbackMessage = wmTrayIcon
	d.Icon = a.icon
	copyU16(d.Tip[:], tip)
	if !a.added {
		if r, _, _ := pShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&d))); r != 0 {
			a.added = true
		}
	} else {
		pShellNotifyIconW.Call(nimModify, uintptr(unsafe.Pointer(&d)))
	}
	if old != 0 {
		pDestroyIcon.Call(uintptr(old))
	}
}

func (a *app) balloon(title, text string) {
	d := a.iconData()
	d.Flags = nifInfo
	d.InfoFlags = niifInfo
	copyU16(d.InfoTitle[:], title)
	copyU16(d.Info[:], text)
	pShellNotifyIconW.Call(nimModify, uintptr(unsafe.Pointer(&d)))
}

func (a *app) removeIcon() {
	if a.added {
		d := a.iconData()
		pShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&d)))
	}
}

// ── Menu ────────────────────────────────────────────────────────────────────

func appendItem(menu uintptr, flags uint32, id uintptr, text string) {
	pAppendMenuW.Call(menu, uintptr(flags), id, uintptr(unsafe.Pointer(u16(text))))
}

func (a *app) showMenu() {
	s, have := a.snapshot()
	menu, _, _ := pCreatePopupMenu.Call()
	defer pDestroyMenu.Call(menu)
	chatFlags := uint32(mfString)
	if !have || s.Offline || (!s.Chat.Open && (s.Remote != "" || !s.HasBusiness)) || s.Chat.OtherUser {
		chatFlags |= mfGrayed
	}
	appendItem(menu, chatFlags, idChat, menuLabel(s))
	supFlags := uint32(mfString)
	if !have || !s.HasBusiness {
		supFlags |= mfGrayed
	}
	appendItem(menu, supFlags, idSupport, "Open a support request…")
	sub, _, _ := pCreatePopupMenu.Call()
	for i, t := range s.Tools {
		f := uint32(mfString)
		if t.Blocked != "" || a.busyTool {
			f |= mfGrayed
		}
		appendItem(sub, f, uintptr(idToolBase+i), toolLabel(t))
	}
	if len(s.Tools) == 0 {
		appendItem(sub, mfString|mfGrayed, 0, "No tools available")
	}
	appendItem(menu, mfPopup, sub, "Self-help tools")
	appendItem(menu, mfSeparator, 0, "")
	appendItem(menu, mfString, idAbout, "About")

	var pt point
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	pSetForegroundWindow.Call(uintptr(a.hwnd))
	cmd, _, _ := pTrackPopupMenu.Call(menu, tpmRightAlign|tpmBottom|tpmReturnCmd, uintptr(pt.X), uintptr(pt.Y), 0, uintptr(a.hwnd), 0)
	switch {
	case cmd == idChat:
		a.openChat()
	case cmd == idSupport:
		a.openSupport()
	case cmd == idAbout:
		msgBox(a.hwnd, aboutText(s), "About", mbOK|mbIconInfo)
	case cmd >= idToolBase && int(cmd-idToolBase) < len(s.Tools):
		a.runTool(s.Tools[cmd-idToolBase])
	}
}

// ── Chat ────────────────────────────────────────────────────────────────────

func (a *app) chatOpen() bool {
	w, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(u16(chatClass))), 0)
	if w != 0 {
		return true
	}
	return false
}

// openChat brings an open chat window forward, or mints a one-time link and
// opens it: in the tray's own WebView2 window when the runtime is present,
// else in the default browser, and says so.
func (a *app) openChat() {
	if w, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(u16(chatClass))), 0); w != 0 {
		pShowWindow.Call(w, swShowNormal)
		pSetForegroundWindow.Call(w)
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		u, err := a.backend.OpenChat(ctx)
		a.onUI(func() {
			if err != nil {
				msgBox(a.hwnd, err.Error(), "Chat with support", mbOK|mbIconWarn)
				return
			}
			if !tray.ValidPortal(a.portal) || !strings.HasPrefix(u, "https://"+a.portal+"/assist/open?c=") {
				msgBox(a.hwnd, "The chat link was not for this computer's portal, so it was not opened.", "Chat with support", mbOK|mbIconError)
				return
			}
			if webView2Available() {
				if err := a.startChatWindow(u); err == nil {
					return
				}
			}
			openInBrowser(u)
			a.balloon("Chat opened in your browser", "The chat window needs Microsoft Edge WebView2, which is not installed here, so the chat opened in your default browser instead.")
		})
	}()
}

func (a *app) startChatWindow(u string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--chat-window", "--portal", a.portal)
	cmd.Stdin = strings.NewReader(u + "\n")
	if err := cmd.Start(); err != nil {
		return err
	}
	a.chatCmd = cmd
	go cmd.Wait()
	return nil
}

func openInBrowser(u string) {
	_ = windows.ShellExecute(0, u16("open"), u16(u), nil, nil, swShowNormal)
}

// ── Self-help ───────────────────────────────────────────────────────────────

func (a *app) runTool(t tray.ToolState) {
	if t.Blocked != "" {
		msgBox(a.hwnd, t.Blocked, t.Title, mbOK|mbIconInfo)
		return
	}
	if t.ID == "ip.renew" && msgBox(a.hwnd, tray.RenewWarning, t.Title, mbYesNo|mbIconWarn) != idYes {
		return
	}
	if t.ID == "rustdesk.restart" && msgBox(a.hwnd, "This restarts the remote support service. It is not done while a remote session is open. Continue?", t.Title, mbYesNo|mbIconWarn) != idYes {
		return
	}
	a.busyTool = true
	a.balloon(t.Title, "Running… the result appears when it finishes.")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		r, err := a.backend.SelfHelp(ctx, t.ID)
		a.onUI(func() {
			a.busyTool = false
			if err != nil {
				msgBox(a.hwnd, err.Error(), t.Title, mbOK|mbIconWarn)
				return
			}
			icon := uintptr(mbIconInfo)
			if r.Outcome != tray.OutcomeSucceeded {
				icon = mbIconWarn
			}
			msgBox(a.hwnd, resultText(r), t.Title, mbOK|icon)
		})
	}()
}
