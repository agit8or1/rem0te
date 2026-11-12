package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client speaks the two device routes, with the device secret exactly as the
// heartbeat sends it. Only the SYSTEM chat host holds one.
type Client struct {
	Base       string // https://portal/api/v1
	RustdeskID string
	Secret     string
	HTTP       *http.Client
}

// ErrUnauthorized: the portal does not recognise this device (401). The host
// stops; the heartbeat will start it again if a chat is still open.
var ErrUnauthorized = errors.New("the portal did not recognise this device")

// HTTPError is any other refusal, with the portal's code when it sent one.
type HTTPError struct {
	Status int
	Code   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("portal refused (HTTP %d %s)", e.Status, e.Code)
}

type PollRequest struct {
	ConversationID string   `json:"conversationId,omitempty"`
	State          string   `json:"state,omitempty"`
	Detail         string   `json:"detail,omitempty"`
	UserName       string   `json:"userName,omitempty"`
	Delivered      []string `json:"delivered,omitempty"`
	Shown          []string `json:"shown,omitempty"`
	Read           []string `json:"read,omitempty"`
	History        bool     `json:"history,omitempty"`
	NoWait         bool     `json:"noWait,omitempty"`
}

type Conversation struct {
	ID             string `json:"id"`
	Status         string `json:"status"` // OPEN | ENDED
	BusinessName   string `json:"businessName"`
	TechnicianName string `json:"technicianName"`
	EndedReason    string `json:"endedReason"`
}

type Message struct {
	ID   string `json:"id"`
	From string `json:"from"` // technician | user
	Name string `json:"name"`
	Text string `json:"text"`
	At   string `json:"at"`
}

type PollResponse struct {
	Conversation *Conversation `json:"conversation"`
	Messages     []Message     `json:"messages"`
	RetryAfterMs int           `json:"retryAfterMs"`
}

type ReplyResponse struct {
	ID        string `json:"id"`
	Duplicate bool   `json:"duplicate"`
}

const maxResponseBytes = 2 << 20

func (c *Client) post(ctx context.Context, path string, body map[string]any, out any) error {
	body["rustdeskId"] = c.RustdeskID
	body["agentSecret"] = c.Secret
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 45 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(b) > maxResponseBytes {
		return errors.New("portal response too large")
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode/100 != 2 {
		var e struct {
			Code    string `json:"code"`
			Message struct {
				Code string `json:"code"`
			} `json:"message"`
		}
		_ = json.Unmarshal(b, &e)
		code := e.Code
		if code == "" {
			code = e.Message.Code
		}
		return &HTTPError{Status: resp.StatusCode, Code: code}
	}
	var env struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil || !env.Success {
		return errors.New("portal response is not a success envelope")
	}
	return json.Unmarshal(env.Data, out)
}

// Poll: acknowledgements and window state out, the conversation and any
// technician messages not yet confirmed back. Held by the portal for up to
// 25 s when there is nothing new.
func (c *Client) Poll(ctx context.Context, p PollRequest) (PollResponse, error) {
	body := map[string]any{}
	raw, _ := json.Marshal(p)
	_ = json.Unmarshal(raw, &body)
	var out PollResponse
	err := c.post(ctx, "/enrollment/chat/poll", body, &out)
	return out, err
}

// Reply posts what the person typed. clientID makes a retry safe: the portal
// answers a repeat with the message it already stored.
func (c *Client) Reply(ctx context.Context, conversationID, clientID, text string) (ReplyResponse, error) {
	var out ReplyResponse
	err := c.post(ctx, "/enrollment/chat/reply", map[string]any{"conversationId": conversationID, "clientId": clientID, "text": text}, &out)
	return out, err
}
