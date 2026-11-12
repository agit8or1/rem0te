package tray

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"
)

// Credential is how a Client authenticates to /tray/*. Exactly one is set:
//
//   - Device: the signed agent's device secret, held by the SYSTEM tray host
//     only (heartbeat.dat is SYSTEM and Administrators). The portal accepts
//     it on /tray/* only for a computer on the signed channel.
//   - TrayKey: the standard agent's per-install tray key (tray.json, readable
//     by the computer's users). The portal accepts it for what the person at
//     the computer can do through the tray, and never for an elevated tool.
type Credential struct {
	RustdeskID string
	Secret     string
	TrayKey    string
}

var trayKeyRE = regexp.MustCompile(`^tk_[a-z0-9]{24}\.[A-Za-z0-9_-]{43}$`)

// ValidTrayKey is a key as /tray/pair mints it.
func ValidTrayKey(s string) bool { return trayKeyRE.MatchString(s) }

func (c Credential) body() (map[string]any, error) {
	switch {
	case c.TrayKey != "" && c.Secret == "":
		if !ValidTrayKey(c.TrayKey) {
			return nil, errors.New("tray.json holds no valid tray key")
		}
		return map[string]any{"trayKey": c.TrayKey}, nil
	case c.Secret != "" && c.TrayKey == "":
		return map[string]any{"rustdeskId": c.RustdeskID, "agentSecret": c.Secret}, nil
	}
	return nil, errors.New("a tray client needs exactly one credential")
}

// APIError is a refusal from the portal: its HTTP status, code and message.
// Anything else (no route, a timeout, a TLS failure) is a plain error, and
// means the portal could not be reached.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("portal %d %s: %s", e.Status, e.Code, e.Message)
}

// Unreachable: the request never got an answer from the portal.
func Unreachable(err error) bool {
	var ae *APIError
	return err != nil && !errors.As(err, &ae)
}

// Client speaks to the portal's /tray/* routes.
type Client struct {
	Base string // https://<portal>/api/v1
	Cred Credential
	HTTP *http.Client
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (c *Client) post(ctx context.Context, path string, extra map[string]any, out any) error {
	body, err := c.Cred.body()
	if err != nil {
		return err
	}
	for k, v := range extra {
		body[k] = v
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "rem0te-tray/1")
	resp, err := c.http().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(b, &e)
		if e.Code == "" && e.Message == "" {
			// Not the portal's envelope (a proxy's error page): not an answer.
			return fmt.Errorf("portal returned HTTP %d without a portal error", resp.StatusCode)
		}
		return &APIError{Status: resp.StatusCode, Code: CleanLine(e.Code, 64), Message: CleanLine(e.Message, 300)}
	}
	var env struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil || !env.Success {
		return fmt.Errorf("portal answered %s without a success envelope", path)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(env.Data, out)
}

// PortalStatus is POST /tray/status's data.
type PortalStatus struct {
	BusinessName string `json:"businessName"`
	ProviderName string `json:"providerName"`
	SupportText  string `json:"supportText"`
	Accent       string `json:"accent"`
	Agent        string `json:"agent"`
	HasBusiness  bool   `json:"hasBusiness"`
	BusinessID   string `json:"businessId"`
	Chat         struct {
		Open           bool     `json:"open"`
		ConversationID string   `json:"conversationId"`
		StartedBy      string   `json:"startedBy"`
		Recorded       bool     `json:"recorded"`
		Unread         []string `json:"unread"`
		AutoOpen       bool     `json:"autoOpen"`
		OtherUser      bool     `json:"otherUser"`
	} `json:"chat"`
	RecordNew bool `json:"recordNew"`
	Contained struct {
		Remote  *string `json:"remote"`
		Actions *string `json:"actions"`
	} `json:"contained"`
	SelfHelp []struct {
		ID       string  `json:"id"`
		Title    string  `json:"title"`
		Elevated bool    `json:"elevated"`
		Blocked  *string `json:"blocked"`
	} `json:"selfHelp"`
	PollSeconds int `json:"pollSeconds"`
}

// Status: the tray's state, and "these technician messages reached the tray" (delivered).
func (c *Client) Status(ctx context.Context, localUser string, delivered []string) (PortalStatus, error) {
	var s PortalStatus
	extra := map[string]any{"localUser": localUser}
	if len(delivered) > 0 {
		extra["delivered"] = delivered
	}
	err := c.post(ctx, "/tray/status", extra, &s)
	return s, err
}

// ChatCode: a one-time code for /assist/open.
func (c *Client) ChatCode(ctx context.Context, localUser string) (string, error) {
	var r struct {
		Code string `json:"code"`
	}
	if err := c.post(ctx, "/tray/chat-code", map[string]any{"localUser": localUser}, &r); err != nil {
		return "", err
	}
	if !ValidCode(r.Code) {
		return "", errors.New("the portal returned a malformed chat code")
	}
	return r.Code, nil
}

// Support sends a support request. usage and shot are optional (nil / empty).
func (c *Client) Support(ctx context.Context, localUser, text string, usage *Usage, shotB64 string) (string, error) {
	extra := map[string]any{"localUser": localUser, "description": text}
	if usage != nil {
		extra["usage"] = usage
	}
	if shotB64 != "" {
		extra["screenshot"] = shotB64
	}
	var r struct {
		ID string `json:"id"`
	}
	err := c.post(ctx, "/tray/support-requests", extra, &r)
	return r.ID, err
}

// Begin asks whether a tool may run now; the portal records the run.
func (c *Client) Begin(ctx context.Context, localUser, tool string) (string, error) {
	var r struct {
		RunID string `json:"runId"`
	}
	err := c.post(ctx, "/tray/self-help/begin", map[string]any{"localUser": localUser, "tool": tool}, &r)
	return r.RunID, err
}

// RunReport is what came of a run, for POST /tray/self-help/result.
type RunReport struct {
	RunID   string    // from Begin; empty for an offline run
	Tool    string    // offline runs only
	RanAt   time.Time // offline runs only
	Outcome string
	Summary string
	Lines   []string
	User    string
}

func (c *Client) Result(ctx context.Context, r RunReport) error {
	extra := map[string]any{"localUser": r.User, "outcome": r.Outcome, "summary": r.Summary, "detail": r.Lines}
	if r.RunID != "" {
		extra["runId"] = r.RunID
	} else {
		extra["offline"] = true
		extra["tool"] = r.Tool
		extra["ranAt"] = r.RanAt.UTC().Format(time.RFC3339)
	}
	if len(r.Lines) > 40 {
		extra["detail"] = r.Lines[:40]
	}
	return c.post(ctx, "/tray/self-help/result", extra, nil)
}
