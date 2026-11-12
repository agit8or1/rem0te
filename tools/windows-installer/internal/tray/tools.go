package tray

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

// Adapter is one network adapter as net.details shows it.
type Adapter struct {
	Name     string
	Up       bool
	DHCP     bool
	MAC      string
	IPv4     []string
	IPv6     []string
	Gateways []string
	DNS      []string
}

// OS is everything a self-help tool touches. Each method is one fixed
// operation; none takes anything the person at the computer typed. The
// Windows implementation runs only ipconfig.exe and ping.exe, from System32
// by absolute path, without a shell, with fixed arguments (ping's one
// argument is a gateway address read from the adapter table and checked to
// be an IP address).
type OS interface {
	Resolve(ctx context.Context, host string) ([]string, error)
	Adapters() ([]Adapter, error)
	DialTLS(ctx context.Context, hostport string) (time.Duration, error)
	Ping(ctx context.Context, ip string) (time.Duration, error)
	// Elevated: the signed tray host only. Elsewhere they return ErrNotHere.
	FlushDNS() (string, error)
	RenewIP() (string, error)
	RemoteSessions() (int, error)
	RestartRustDesk() error
}

// ErrNotHere: an elevated operation asked of a process that cannot do it.
var ErrNotHere = errors.New("this tool runs only in the signed agent")

// Result is what a run did, in words. Lines are already inert.
type Result struct {
	Outcome string
	Summary string
	Lines   []string
}

// Runner runs catalog tools. Elevated is true only in the signed tray host,
// which runs as SYSTEM; the standard tray runs the read-only tools only.
type Runner struct {
	OS       OS
	Portal   string // the pinned portal host[:port] — the name the DNS and connection tests check
	Elevated bool
}

func res(outcome, summary string, lines ...string) Result {
	return Result{Outcome: outcome, Summary: CleanLine(summary, 300), Lines: cleanLines(lines)}
}

// Run runs one tool. An unknown tool, or an elevated one here without
// elevation, is refused without touching the OS.
func (r *Runner) Run(ctx context.Context, id string) Result {
	t, ok := Tool(id)
	if !ok {
		return res(OutcomeRefused, "That is not one of the self-help tools.")
	}
	if t.Elevated && !r.Elevated {
		return res(OutcomeRefused, ErrNotHere.Error()+".")
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	switch t.ID {
	case "dns.check":
		return r.dnsCheck(ctx)
	case "dns.flush":
		out, err := r.OS.FlushDNS()
		if err != nil {
			return res(OutcomeFailed, "The DNS cache could not be flushed: "+err.Error(), outLines(out)...)
		}
		return res(OutcomeSucceeded, "The DNS cache was flushed.", outLines(out)...)
	case "ip.renew":
		out, err := r.OS.RenewIP()
		lines := outLines(out)
		if ads, aerr := r.OS.Adapters(); aerr == nil {
			lines = append(lines, adapterLines(ads)...)
		}
		if err != nil {
			return res(OutcomeFailed, "The IP address could not be renewed: "+err.Error(), lines...)
		}
		return res(OutcomeSucceeded, "The IP address was renewed.", lines...)
	case "net.test":
		return r.netTest(ctx)
	case "net.details":
		ads, err := r.OS.Adapters()
		if err != nil {
			return res(OutcomeFailed, "The network adapters could not be read: "+err.Error())
		}
		up := 0
		for _, a := range ads {
			if a.Up {
				up++
			}
		}
		return res(OutcomeSucceeded, fmt.Sprintf("%d network adapter(s), %d connected.", len(ads), up), adapterLines(ads)...)
	case "rustdesk.restart":
		// The 0.32 rule: restarting RustDesk drops whoever is connected, so
		// it waits for no open session, and "cannot tell" counts as open.
		n, err := r.OS.RemoteSessions()
		if err != nil {
			return res(OutcomeRefused, "Could not tell whether a remote session is open, so the remote support service was not restarted.")
		}
		if n > 0 {
			return res(OutcomeRefused, "A remote support session is open on this computer, so the service was not restarted. Try again when nobody is connected.")
		}
		if err := r.OS.RestartRustDesk(); err != nil {
			return res(OutcomeFailed, "The remote support service could not be restarted: "+err.Error())
		}
		return res(OutcomeSucceeded, "The remote support service was restarted.")
	}
	return res(OutcomeRefused, "That is not one of the self-help tools.")
}

func (r *Runner) portalHost() (string, string) {
	host, port, err := net.SplitHostPort(r.Portal)
	if err != nil {
		return r.Portal, "443"
	}
	return host, port
}

// NCSIHost is the name Windows itself resolves to decide it is online.
const NCSIHost = "www.msftconnecttest.com"

func (r *Runner) dnsCheck(ctx context.Context) Result {
	host, _ := r.portalHost()
	var lines []string
	okPortal, okPublic := false, false
	for _, name := range []string{host, NCSIHost} {
		addrs, err := r.OS.Resolve(ctx, name)
		if err != nil || len(addrs) == 0 {
			lines = append(lines, fmt.Sprintf("%s: not resolved (%v)", name, errOr(err, "no addresses")))
			continue
		}
		if len(addrs) > 4 {
			addrs = addrs[:4]
		}
		lines = append(lines, fmt.Sprintf("%s: %s", name, strings.Join(addrs, ", ")))
		if name == host {
			okPortal = true
		} else {
			okPublic = true
		}
	}
	if ads, err := r.OS.Adapters(); err == nil {
		for _, a := range ads {
			if a.Up && len(a.DNS) > 0 {
				lines = append(lines, fmt.Sprintf("DNS servers (%s): %s", a.Name, strings.Join(a.DNS, ", ")))
			}
		}
	}
	switch {
	case okPortal && okPublic:
		return res(OutcomeSucceeded, "DNS is working.", lines...)
	case okPublic:
		return res(OutcomeFailed, "Public names resolve, but your IT provider's portal does not.", lines...)
	case okPortal:
		return res(OutcomeFailed, "Your IT provider's portal resolves, but public names do not.", lines...)
	}
	return res(OutcomeFailed, "DNS is not working: no name could be resolved.", lines...)
}

func (r *Runner) netTest(ctx context.Context) Result {
	var lines []string
	gwOK, gwTried := false, false
	if ads, err := r.OS.Adapters(); err == nil {
		for _, a := range ads {
			if !a.Up {
				continue
			}
			for _, gw := range a.Gateways {
				if net.ParseIP(gw) == nil || net.ParseIP(gw).To4() == nil {
					continue
				}
				gwTried = true
				if d, err := r.OS.Ping(ctx, gw); err == nil {
					gwOK = true
					lines = append(lines, fmt.Sprintf("Gateway %s (%s): answered in %d ms", gw, a.Name, d.Milliseconds()))
				} else {
					lines = append(lines, fmt.Sprintf("Gateway %s (%s): no answer", gw, a.Name))
				}
			}
		}
	} else {
		lines = append(lines, "Network adapters could not be read: "+err.Error())
	}
	if !gwTried {
		lines = append(lines, "No connected adapter has a default gateway.")
	}
	host, port := r.portalHost()
	portalOK := false
	if d, err := r.OS.DialTLS(ctx, net.JoinHostPort(host, port)); err == nil {
		portalOK = true
		lines = append(lines, fmt.Sprintf("Your IT provider's portal (%s): connected securely in %d ms", host, d.Milliseconds()))
	} else {
		lines = append(lines, fmt.Sprintf("Your IT provider's portal (%s): could not connect (%v)", host, err))
	}
	switch {
	case portalOK:
		return res(OutcomeSucceeded, "This computer can reach your IT provider.", lines...)
	case gwOK:
		return res(OutcomeFailed, "The local network answers, but your IT provider cannot be reached.", lines...)
	}
	return res(OutcomeFailed, "This computer does not appear to be connected to a network.", lines...)
}

func errOr(err error, s string) string {
	if err != nil {
		return err.Error()
	}
	return s
}

func adapterLines(ads []Adapter) []string {
	var lines []string
	for _, a := range ads {
		state := "disconnected"
		if a.Up {
			state = "connected"
		}
		l := fmt.Sprintf("%s: %s", a.Name, state)
		if a.DHCP {
			l += ", DHCP"
		}
		if a.MAC != "" {
			l += ", MAC " + a.MAC
		}
		lines = append(lines, l)
		if len(a.IPv4) > 0 {
			lines = append(lines, "  IPv4: "+strings.Join(a.IPv4, ", "))
		}
		if len(a.IPv6) > 0 {
			lines = append(lines, "  IPv6: "+strings.Join(a.IPv6, ", "))
		}
		if len(a.Gateways) > 0 {
			lines = append(lines, "  Gateway: "+strings.Join(a.Gateways, ", "))
		}
		if len(a.DNS) > 0 {
			lines = append(lines, "  DNS: "+strings.Join(a.DNS, ", "))
		}
	}
	return lines
}

// outLines is a command's output as at most 30 non-empty lines.
func outLines(out string) []string {
	var lines []string
	for _, l := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		if l = strings.TrimSpace(l); l != "" && len(lines) < 30 {
			lines = append(lines, l)
		}
	}
	return lines
}
