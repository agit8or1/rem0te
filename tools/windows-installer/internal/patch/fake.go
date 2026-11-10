package patch

import (
	"encoding/json"
	"errors"
	"time"
)

// FakeWUA is a simulated Windows Update Agent for tests and for
// rem0te-action-sim. It answers in exactly the shape wua.ps1 writes, so the
// parsing and every decision above it are the shipped code.
type FakeWUA struct {
	Offered    []Update       `json:"offered"`
	Installed  []Identity     `json:"installed"`
	Superseded []Identity     `json:"superseded"`
	History    []HistoryEntry `json:"history"`
	// Results by Identity.Key(); missing means success without a restart.
	Results map[string]FakeResult `json:"results,omitempty"`
	// Fail: "" | scan | lookup | install_crash (the script dies mid-install)
	Fail           string `json:"fail,omitempty"`
	RebootRequired bool   `json:"rebootRequired"`
	// Calls records each mode run, for tests.
	Calls []string `json:"calls,omitempty"`
}

type FakeResult struct {
	ResultCode     int    `json:"resultCode"`
	RebootRequired bool   `json:"rebootRequired"`
	HResult        string `json:"hresult,omitempty"`
}

func (f *FakeWUA) has(list []Identity, id Identity) bool {
	for _, x := range list {
		if x.Key() == id.Key() {
			return true
		}
	}
	return false
}

func (f *FakeWUA) offered(id Identity) *Update {
	for i := range f.Offered {
		if f.Offered[i].ID().Key() == id.Key() {
			return &f.Offered[i]
		}
	}
	return nil
}

func (f *FakeWUA) Run(mode string, ids []Identity) ([]byte, error) {
	f.Calls = append(f.Calls, mode)
	switch mode {
	case "scan":
		if f.Fail == "scan" {
			return nil, errors.New("0x8024402C: the update service could not be reached")
		}
		h := f.History
		if h == nil {
			h = []HistoryEntry{}
		}
		o := f.Offered
		if o == nil {
			o = []Update{}
		}
		return json.Marshal(ScanOut{Updates: o, History: h, RebootRequired: f.RebootRequired})
	case "lookup":
		if f.Fail == "lookup" {
			return nil, errors.New("0x80072EE2: the operation timed out")
		}
		out := LookupOut{Results: []LookupState{}}
		for _, id := range ids {
			st := LookupState{UpdateID: id.UpdateID, Revision: id.Revision, State: "not_found"}
			if u := f.offered(id); u != nil {
				c := *u
				st.State, st.Update = "offered", &c
			} else if f.has(f.Installed, id) {
				st.State = "installed"
			} else if f.has(f.Superseded, id) {
				st.State = "superseded"
			}
			out.Results = append(out.Results, st)
		}
		return json.Marshal(out)
	case "install":
		if f.Fail == "install_crash" {
			return nil, errors.New("powershell exited with status -1073741510")
		}
		out := InstallOut{Results: []InstallState{}}
		var keep []Update
		installed := map[string]bool{}
		for _, id := range ids {
			r := InstallState{UpdateID: id.UpdateID, Revision: id.Revision}
			if u := f.offered(id); u != nil && u.EulaAccepted {
				r.Found, r.Downloaded = true, true
				res, ok := f.Results[id.Key()]
				if !ok {
					res = FakeResult{ResultCode: 2}
				}
				r.ResultCode, r.RebootRequired, r.HResult = res.ResultCode, res.RebootRequired, res.HResult
				if r.HResult == "" {
					r.HResult = "0x00000000"
				}
				if res.RebootRequired {
					out.RebootRequired = true
					f.RebootRequired = true
				}
				result := "failed"
				if res.ResultCode == 2 {
					installed[id.Key()] = true
					f.Installed = append(f.Installed, id)
					result = "succeeded"
				}
				f.History = append([]HistoryEntry{{UpdateID: id.UpdateID, Revision: id.Revision, KB: u.KB, Title: u.Title, Result: result,
					HResult: r.HResult, Operation: "install", Date: time.Now().UTC().Format(time.RFC3339)}}, f.History...)
			}
			out.Results = append(out.Results, r)
		}
		for _, u := range f.Offered {
			if !installed[u.ID().Key()] {
				keep = append(keep, u)
			}
		}
		f.Offered = keep
		return json.Marshal(out)
	}
	return nil, errors.New("unknown mode")
}

// Restart is what a reboot does to the fake: pending restarts clear.
func (f *FakeWUA) Restart() { f.RebootRequired = false }

// FakeRegistry holds the values manager and reboot detection read.
type FakeRegistry struct {
	Strings  map[string]string `json:"strings,omitempty"` // "key|name" → value
	DWords   map[string]uint32 `json:"dwords,omitempty"`
	Keys     []string          `json:"keys,omitempty"`
	Values   []string          `json:"values,omitempty"` // "key|name" that exist
	Services []string          `json:"services,omitempty"`
}

func (r *FakeRegistry) String(k, n string) (string, bool) { v, ok := r.Strings[k+"|"+n]; return v, ok }
func (r *FakeRegistry) DWord(k, n string) (uint32, bool)  { v, ok := r.DWords[k+"|"+n]; return v, ok }
func (r *FakeRegistry) KeyExists(k string) bool           { return contains(r.Keys, k) }
func (r *FakeRegistry) ValueExists(k, n string) bool {
	if _, ok := r.Strings[k+"|"+n]; ok {
		return true
	}
	if _, ok := r.DWords[k+"|"+n]; ok {
		return true
	}
	return contains(r.Values, k+"|"+n)
}
func (r *FakeRegistry) ServiceExists(n string) bool { return contains(r.Services, n) }

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}
