package remote

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"sync"
	"time"
)

// memFilePortal is an in-memory portal for file transfer: it serves an
// upload's chunks from Up and collects a download's into Down, and records
// how each transfer finished. Used by files_test.go and the Windows lab.
type memFilePortal struct {
	mu       sync.Mutex
	Up       []byte
	Down     []byte
	Begun    bool
	Size     int64
	SHA      string
	Finished chan FileReply
	Ended    bool
	// WaitFirst: answer the first n pulls/pushes with "wait".
	WaitFirst int
	// Corrupt: serve chunk n with a wrong hash.
	Corrupt int
}

// tid is a transfer id for the tests.
const tid = "0123456789abcdef0123456789abcdef"

func newMemFilePortal() *memFilePortal { return &memFilePortal{Finished: make(chan FileReply, 4)} }

func hexSHA(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func (m *memFilePortal) FilePull(_ context.Context, _ string, seq int) (FileReply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Ended {
		return FileReply{End: true, Reason: "cancelled"}, nil
	}
	if m.WaitFirst > 0 {
		m.WaitFirst--
		return FileReply{Wait: true}, nil
	}
	off := (seq - 1) * FileChunkBytes
	if off >= len(m.Up) {
		return FileReply{Done: true}, nil
	}
	end := off + FileChunkBytes
	if end > len(m.Up) {
		end = len(m.Up)
	}
	b := m.Up[off:end]
	sum := hexSHA(b)
	if seq == m.Corrupt {
		sum = hexSHA([]byte("not it"))
	}
	return FileReply{Seq: seq, Data: base64.StdEncoding.EncodeToString(b), SHA256: sum}, nil
}

func (m *memFilePortal) FileBegin(_ context.Context, _ string, size int64, sha string) (FileReply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Ended {
		return FileReply{End: true}, nil
	}
	m.Begun, m.Size, m.SHA = true, size, sha
	return FileReply{}, nil
}

func (m *memFilePortal) FilePush(_ context.Context, _ string, _ int, data, sha string) (FileReply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Ended {
		return FileReply{End: true}, nil
	}
	if m.WaitFirst > 0 {
		m.WaitFirst--
		return FileReply{Wait: true}, nil
	}
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil || hexSHA(b) != sha {
		return FileReply{End: true, Reason: "http_400"}, nil
	}
	m.Down = append(m.Down, b...)
	return FileReply{}, nil
}

func (m *memFilePortal) FileFinish(_ context.Context, _ string, ok bool, size int64, sha, code string) (FileReply, error) {
	m.Finished <- FileReply{Done: ok, Reason: code, SHA256: sha, Seq: int(size)}
	return FileReply{End: true}, nil
}

func (m *memFilePortal) end() {
	m.mu.Lock()
	m.Ended = true
	m.mu.Unlock()
}

// waitFinished returns how a transfer finished, or fails after d.
func (m *memFilePortal) waitFinished(d time.Duration) (FileReply, bool) {
	select {
	case r := <-m.Finished:
		return r, true
	case <-time.After(d):
		return FileReply{}, false
	}
}
