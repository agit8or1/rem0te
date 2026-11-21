package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// HTTPPortal is the worker's portal client: every call carries this
// computer's RustDesk ID and device secret in the body, which the portal
// checks before reading anything else. The secret never leaves this process
// otherwise and is never logged.
type HTTPPortal struct {
	// Base is the API base, e.g. https://portal.example.com/api/v1.
	Base   string
	RID    string
	Secret string
	HC     *http.Client
}

func (h *HTTPPortal) post(ctx context.Context, path string, body any, timeout time.Duration) ([]byte, int, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(c, http.MethodPost, h.Base+path, bytes.NewReader(b))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	hc := h.HC
	if hc == nil {
		hc = &http.Client{}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return raw, resp.StatusCode, err
}

type pollBody struct {
	RustdeskID  string `json:"rustdeskId"`
	AgentSecret string `json:"agentSecret"`
	Wait        bool   `json:"wait"`
	Terminals   []Held `json:"terminals"`
}

// Poll asks for work, held by the portal for up to 20 s.
func (h *HTTPPortal) Poll(ctx context.Context, held []Held, wait bool) (PollAnswer, error) {
	if held == nil {
		held = []Held{}
	}
	raw, code, err := h.post(ctx, "/remote/agent/poll", pollBody{RustdeskID: h.RID, AgentSecret: h.Secret, Wait: wait, Terminals: held}, 50*time.Second)
	if err != nil {
		return PollAnswer{}, err
	}
	switch {
	case code == http.StatusUnauthorized || code == http.StatusForbidden || code == http.StatusNotFound:
		return PollAnswer{}, ErrStop
	case code != http.StatusOK:
		return PollAnswer{}, fmt.Errorf("poll: HTTP %d", code)
	}
	var env struct {
		Data PollAnswer `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return PollAnswer{}, err
	}
	return env.Data, nil
}

type outputBody struct {
	RustdeskID  string `json:"rustdeskId"`
	AgentSecret string `json:"agentSecret"`
	OutputPost
}

// Output posts what one terminal did. A session the portal does not know
// (404) or will not take (400) is ended here too.
func (h *HTTPPortal) Output(ctx context.Context, p OutputPost) (OutputReply, error) {
	raw, code, err := h.post(ctx, "/remote/agent/terminal/output", outputBody{RustdeskID: h.RID, AgentSecret: h.Secret, OutputPost: p}, 30*time.Second)
	if err != nil {
		return OutputReply{}, err
	}
	switch {
	case code == http.StatusNotFound || code == http.StatusBadRequest || code == http.StatusUnauthorized || code == http.StatusForbidden:
		return OutputReply{End: true, Reason: fmt.Sprintf("http_%d", code)}, nil
	case code != http.StatusOK:
		return OutputReply{}, fmt.Errorf("output: HTTP %d", code)
	}
	var env struct {
		Data OutputReply `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return OutputReply{}, err
	}
	return env.Data, nil
}
