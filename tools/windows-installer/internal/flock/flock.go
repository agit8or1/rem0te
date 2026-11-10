// Package flock is an exclusive, non-blocking lock on a file, held for the
// life of the process that took it. The operating system releases it when
// that process exits for any reason, which is the point: a lock that is free
// while a job's journal says "executing" means the process running it died.
package flock

import (
	"errors"
	"os"
	"path/filepath"
	"time"
)

// ErrBusy means another process holds the lock.
var ErrBusy = errors.New("lock held by another process")

type Lock struct{ f *os.File }

// TryLock takes the lock at path, or returns ErrBusy at once.
func TryLock(path string) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Wait retries TryLock until it succeeds or the timeout passes.
func Wait(path string, timeout, every time.Duration) (*Lock, error) {
	deadline := time.Now().Add(timeout)
	for {
		l, err := TryLock(path)
		if !errors.Is(err, ErrBusy) || !time.Now().Before(deadline) {
			return l, err
		}
		time.Sleep(every)
	}
}

func (l *Lock) Release() {
	if l != nil && l.f != nil {
		unlockFile(l.f)
		l.f.Close()
		l.f = nil
	}
}
