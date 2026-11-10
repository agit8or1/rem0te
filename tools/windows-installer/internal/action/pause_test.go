package action

import (
	"strings"
	"testing"
)

func TestParsePauseIsStrict(t *testing.T) {
	ok := `{"schema":"rem0te-pause/1","issuedAt":"2026-11-10T00:00:00Z","reason":"incident 7","actions":{"all":false,"businesses":["biz-aaaaaaa"]},"updates":{"all":true}}`
	p, err := ParsePause([]byte(ok))
	if err != nil || !p.ActionsPaused("biz-aaaaaaa", "") || p.ActionsPaused("biz-bbbbbbb", "1") || !p.UpdatesPaused() {
		t.Fatalf("%v %+v", err, p)
	}
	for name, bad := range map[string]string{
		"unknown field":   `{"schema":"rem0te-pause/1","issuedAt":"2026-11-10T00:00:00Z","reason":"x","actions":{"all":true},"updates":{"all":false},"resume":true}`,
		"wrong schema":    `{"schema":"rem0te-pause/2","issuedAt":"2026-11-10T00:00:00Z","reason":"x","actions":{"all":true},"updates":{"all":false}}`,
		"bad time":        `{"schema":"rem0te-pause/1","issuedAt":"yesterday","reason":"x","actions":{"all":true},"updates":{"all":false}}`,
		"bad business":    `{"schema":"rem0te-pause/1","issuedAt":"2026-11-10T00:00:00Z","reason":"x","actions":{"all":false,"businesses":["a b"]},"updates":{"all":false}}`,
		"bad rustdesk":    `{"schema":"rem0te-pause/1","issuedAt":"2026-11-10T00:00:00Z","reason":"x","actions":{"all":false,"computers":["12ab"]},"updates":{"all":false}}`,
		"narrow updates":  `{"schema":"rem0te-pause/1","issuedAt":"2026-11-10T00:00:00Z","reason":"x","actions":{"all":false},"updates":{"all":false,"computers":["123456789"]}}`,
		"trailing":        `{"schema":"rem0te-pause/1","issuedAt":"2026-11-10T00:00:00Z","reason":"x","actions":{"all":true},"updates":{"all":false}} {}`,
		"reason too long": `{"schema":"rem0te-pause/1","issuedAt":"2026-11-10T00:00:00Z","reason":"` + strings.Repeat("x", 301) + `","actions":{"all":true},"updates":{"all":false}}`,
	} {
		if _, err := ParsePause([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSignedPauseRefusesAndConsumes(t *testing.T) {
	f := newFixture(t)
	o := f.opts()
	o.Pause = &Pause{Schema: PauseSchema, IssuedAt: "2026-11-10T00:00:00Z", Reason: "incident 7", Actions: PauseScope{Businesses: []string{"biz-aaaaaaa"}}}
	env := f.envelope(basePlan(), nil)
	r, err := Run(job, env, o)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, r, "refused", "paused")
	if f.p.starts != 0 || !strings.Contains(r.Detail, "incident 7") {
		t.Fatalf("starts %d, detail %q", f.p.starts, r.Detail)
	}
	// Final, like any refusal: lifting the pause does not revive this job.
	r2 := f.run(env)
	expect(t, r2, "refused", "paused")
	if f.p.starts != 0 {
		t.Fatal("a paused job ran after the pause was lifted")
	}
}

func TestPauseByComputerAndForOthers(t *testing.T) {
	f := newFixture(t)
	o := f.opts()
	o.Pause = &Pause{Schema: PauseSchema, IssuedAt: "2026-11-10T00:00:00Z", Reason: "lost laptop", Actions: PauseScope{Computers: []string{"123456789"}}}
	r, _ := Run(job, f.envelope(basePlan(), nil), o)
	expect(t, r, "refused", "paused")

	g := newFixture(t)
	og := g.opts()
	og.Pause = &Pause{Schema: PauseSchema, IssuedAt: "2026-11-10T00:00:00Z", Reason: "another business", Actions: PauseScope{Businesses: []string{"biz-zzzzzzz"}, Computers: []string{"987654321"}}}
	r, _ = Run(job, g.envelope(basePlan(), nil), og)
	expect(t, r, "succeeded", "")
}

// A forged envelope is still a bad signature under a pause: the pause never
// becomes a reason to trust the plan's own claims.
func TestPauseCheckedAfterSignature(t *testing.T) {
	f := newFixture(t)
	o := f.opts()
	o.Pause = &Pause{Schema: PauseSchema, IssuedAt: "2026-11-10T00:00:00Z", Reason: "x", Actions: PauseScope{All: true}}
	r, _ := Run(job, f.envelope(basePlan(), func(e map[string]any) { e["sig"] = "AAAA" }), o)
	expect(t, r, "refused", "bad_signature")
}
