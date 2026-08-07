package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateJobRejectsUnusablePaths(t *testing.T) {
	good := UpdateJob{
		AppPath:   "/Applications/Focus Reader.app",
		AsarPath:  "/tmp/staged/app-1.0.1.asar",
		Integrity: strings.Repeat("a", 64),
		SHA256:    strings.Repeat("b", 64),
	}
	if err := validateJob(&good); err != nil {
		t.Fatalf("expected the well-formed job to validate, got %v", err)
	}

	cases := map[string]func(*UpdateJob){
		"relative app path":  func(j *UpdateJob) { j.AppPath = "Focus Reader.app" },
		"not a bundle":       func(j *UpdateJob) { j.AppPath = "/Applications/Focus Reader" },
		"relative asar path": func(j *UpdateJob) { j.AsarPath = "staged.asar" },
		"short integrity":    func(j *UpdateJob) { j.Integrity = "abc" },
		"uppercase digest":   func(j *UpdateJob) { j.SHA256 = strings.Repeat("A", 64) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			job := good
			mutate(&job)
			if err := validateJob(&job); err == nil {
				t.Fatalf("expected %s to be rejected", name)
			}
		})
	}
}

func TestWaitForExitReturnsWhenProcessIsGone(t *testing.T) {
	cmd := exec.Command("/bin/sleep", "0.2")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	pid := cmd.Process.Pid
	go func() { _ = cmd.Wait() }()

	if err := waitForExit(pid, 5*time.Second); err != nil {
		t.Fatalf("expected the exit to be observed, got %v", err)
	}
}

func TestWaitForExitTimesOutRatherThanTouchingALiveBundle(t *testing.T) {
	cmd := exec.Command("/bin/sleep", "5")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	if err := waitForExit(cmd.Process.Pid, 300*time.Millisecond); err == nil {
		t.Fatal("expected a timeout while the process was still running")
	}
}

func TestApplyUpdateRejectsAPayloadWhoseDigestDoesNotMatch(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Fake.app")
	mustMkdirAll(t, filepath.Join(app, "Contents", "Resources"))
	asar := filepath.Join(app, "Contents", "Resources", "app.asar")
	mustWrite(t, asar, []byte("original"))
	mustWrite(t, filepath.Join(app, "Contents", "Info.plist"), []byte("plist"))

	staged := filepath.Join(dir, "staged.asar")
	mustWrite(t, staged, []byte("replacement"))

	job := &UpdateJob{
		AppPath:   app,
		AsarPath:  staged,
		Integrity: strings.Repeat("a", 64),
		SHA256:    strings.Repeat("0", 64), // deliberately not the payload's digest
	}
	if err := applyUpdate(job); err == nil {
		t.Fatal("expected a digest mismatch to abort the install")
	}

	// The bundle must be untouched — not merely restored, but never written.
	if got := mustRead(t, asar); string(got) != "original" {
		t.Fatalf("app.asar was modified despite the mismatch: %q", got)
	}
}

func TestApplyUpdateRollsBackWhenAStepFails(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Fake.app")
	mustMkdirAll(t, filepath.Join(app, "Contents", "Resources"))
	asar := filepath.Join(app, "Contents", "Resources", "app.asar")
	info := filepath.Join(app, "Contents", "Info.plist")
	mustWrite(t, asar, []byte("original asar"))
	// Not a real plist, so PlistBuddy fails and forces the rollback path.
	mustWrite(t, info, []byte("not a plist"))

	payload := []byte("replacement asar")
	staged := filepath.Join(dir, "staged.asar")
	mustWrite(t, staged, payload)
	sum := sha256.Sum256(payload)

	job := &UpdateJob{
		AppPath:   app,
		AsarPath:  staged,
		Integrity: strings.Repeat("a", 64),
		SHA256:    hex.EncodeToString(sum[:]),
	}
	if err := applyUpdate(job); err == nil {
		t.Fatal("expected the integrity rewrite to fail on a bogus plist")
	}

	if got := mustRead(t, asar); string(got) != "original asar" {
		t.Fatalf("rollback did not restore app.asar, got %q", got)
	}
	if got := mustRead(t, info); string(got) != "not a plist" {
		t.Fatalf("rollback did not restore Info.plist, got %q", got)
	}
	// No backup may be left inside the bundle. This is not tidiness: codesign
	// treats any stray file under Contents/ as an unsigned bundle subcomponent
	// and refuses to sign, naming it — which is exactly how this failed against a
	// real bundle. (_CodeSignature/ is codesign's own output and belongs there.)
	var strays []string
	err := filepath.Walk(filepath.Join(app, "Contents"), func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && strings.Contains(info.Name(), ".backup") {
			strays = append(strays, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(strays) > 0 {
		t.Fatalf("rollback left backups inside the bundle: %v", strays)
	}
}

func TestReadJobRejectsMalformedInput(t *testing.T) {
	dir := t.TempDir()

	bad := filepath.Join(dir, "bad.json")
	mustWrite(t, bad, []byte("{not json"))
	if _, err := readJob(bad); err == nil {
		t.Fatal("expected unparseable job to be rejected")
	}

	invalid := filepath.Join(dir, "invalid.json")
	body, _ := json.Marshal(UpdateJob{AppPath: "relative.app"})
	mustWrite(t, invalid, body)
	if _, err := readJob(invalid); err == nil {
		t.Fatal("expected an invalid job to be rejected")
	}
}

func TestWriteFileAtomicReplacesContentInPlace(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "app.asar")
	mustWrite(t, target, []byte("before"))

	if err := writeFileAtomic(target, []byte("after")); err != nil {
		t.Fatalf("writeFileAtomic: %v", err)
	}
	if got := mustRead(t, target); string(got) != "after" {
		t.Fatalf("expected the new content, got %q", got)
	}

	// No temp files may survive the write.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".app.asar.") {
			t.Fatalf("temp file %s was left behind", e.Name())
		}
	}
}

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
