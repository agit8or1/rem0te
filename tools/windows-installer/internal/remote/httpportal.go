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
	// A file chunk is 512 KiB, about 700 KB as base64: 2 MiB is room enough.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	return raw, resp.StatusCode, err
}

type pollBody struct {
	RustdeskID  string   `json:"rustdeskId"`
	AgentSecret string   `json:"agentSecret"`
	Wait        bool     `json:"wait"`
	Terminals   []Held   `json:"terminals"`
	Files       []string `json:"files"`
}

// Poll asks for work, held by the portal for up to 20 s.
func (h *HTTPPortal) Poll(ctx context.Context, held []Held, files []string, wait bool) (PollAnswer, error) {
	if held == nil {
		held = []Held{}
	}
	if files == nil {
		files = []string{}
	}
	raw, code, err := h.post(ctx, "/remote/agent/poll", pollBody{RustdeskID: h.RID, AgentSecret: h.Secret, Wait: wait, Terminals: held, Files: files}, 50*time.Second)
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

type fileBody struct {
	RustdeskID  string `json:"rustdeskId"`
	AgentSecret string `json:"agentSecret"`
	ID          string `json:"id"`
	Seq         int    `json:"seq,omitempty"`
	Size        *int64 `json:"size,omitempty"`
	SHA256      string `json:"sha256,omitempty"`
	Data        string `json:"data,omitempty"`
	OK          *bool  `json:"ok,omitempty"`
	Error       string `json:"error,omitempty"`
}

// file posts one file call. A transfer the portal does not know (404), will
// not take (400) or will not let this computer touch (401/403) is ended here.
func (h *HTTPPortal) file(ctx context.Context, path string, b fileBody) (FileReply, error) {
	b.RustdeskID, b.AgentSecret = h.RID, h.Secret
	raw, code, err := h.post(ctx, "/remote/agent/files/"+path, b, 60*time.Second)
	if err != nil {
		return FileReply{}, err
	}
	switch {
	case code == http.StatusNotFound || code == http.StatusBadRequest || code == http.StatusUnauthorized || code == http.StatusForbidden:
		return FileReply{End: true, Reason: fmt.Sprintf("http_%d", code)}, nil
	case code == http.StatusConflict:
		return FileReply{Wait: true}, nil
	case code != http.StatusOK:
		return FileReply{}, fmt.Errorf("files/%s: HTTP %d", path, code)
	}
	var env struct {
		Data FileReply `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return FileReply{}, err
	}
	return env.Data, nil
}

// FilePull asks for an upload's chunk seq (and so acknowledges those before it).
func (h *HTTPPortal) FilePull(ctx context.Context, id string, seq int) (FileReply, error) {
	return h.file(ctx, "pull", fileBody{ID: id, Seq: seq})
}

// FileBegin declares a download's size and SHA-256.
func (h *HTTPPortal) FileBegin(ctx context.Context, id string, size int64, sha string) (FileReply, error) {
	return h.file(ctx, "begin", fileBody{ID: id, Size: &size, SHA256: sha})
}

// FilePush sends a download's next chunk.
func (h *HTTPPortal) FilePush(ctx context.Context, id string, seq int, data, sha string) (FileReply, error) {
	return h.file(ctx, "push", fileBody{ID: id, Seq: seq, Data: data, SHA256: sha})
}

// FileFinish says how a transfer ended here.
func (h *HTTPPortal) FileFinish(ctx context.Context, id string, ok bool, size int64, sha, code string) (FileReply, error) {
	b := fileBody{ID: id, OK: &ok, Error: code}
	if ok {
		b.Size, b.SHA256 = &size, sha
	}
	return h.file(ctx, "finish", b)
}
