package main

// Delta update installation.
//
// The app cannot rewrite its own bundle: Electron holds app.asar mapped for the
// lifetime of the process, and the swap has to be followed by a relaunch. So the
// app stages a verified payload, spawns this helper detached, and quits. The
// helper lives outside the asar, which is precisely what makes it able to
// replace the asar.
//
// Three things must happen together or not at all:
//
//  1. app.asar is replaced;
//  2. ElectronAsarIntegrity in Info.plist is set to the new header hash —
//     without this the app aborts at startup with a fatal integrity error;
//  3. the bundle is re-signed ad-hoc, because 1 and 2 invalidate the signature.
//
// Any failure rolls the bundle back to exactly what it was.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"syscall"
	"time"
)

// UpdateJob is written by the app and read here. It is a local handoff file,
// not a network document: the payload it names has already been signature- and
// checksum-verified by the app before this helper is spawned.
type UpdateJob struct {
	AppPath   string `json:"app_path"`
	AsarPath  string `json:"asar_path"`
	Integrity string `json:"integrity"`
	SHA256    string `json:"sha256"`
	Version   string `json:"version"`
	WaitPID   int    `json:"wait_pid"`
	Relaunch  bool   `json:"relaunch"`
}

var hexDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)

const (
	waitForExitTimeout = 30 * time.Second
	waitPollInterval   = 100 * time.Millisecond
)

func runApplyUpdate(args []string) int {
	fs := flag.NewFlagSet("apply-update", flag.ContinueOnError)
	jobPath := fs.String("job", "", "path to the update job file")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *jobPath == "" {
		fmt.Fprintln(os.Stderr, "readerctl: apply-update requires --job")
		return 2
	}

	job, err := readJob(*jobPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "readerctl: %v\n", err)
		return 1
	}

	if err := applyUpdate(job); err != nil {
		fmt.Fprintf(os.Stderr, "readerctl: update failed, bundle left unchanged: %v\n", err)
		return 1
	}

	// The job file names a staged payload; both are disposable once installed.
	os.Remove(*jobPath)
	os.Remove(job.AsarPath)

	if job.Relaunch {
		// `open` rather than exec: it goes through LaunchServices, which is what
		// gives the relaunched app a normal session rather than making it a
		// child of this short-lived helper.
		_ = exec.Command("/usr/bin/open", job.AppPath).Run()
	}
	return 0
}

func readJob(path string) (*UpdateJob, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read job: %w", err)
	}
	var job UpdateJob
	if err := json.Unmarshal(data, &job); err != nil {
		return nil, fmt.Errorf("cannot parse job: %w", err)
	}
	if err := validateJob(&job); err != nil {
		return nil, err
	}
	return &job, nil
}

func validateJob(job *UpdateJob) error {
	if !filepath.IsAbs(job.AppPath) || filepath.Ext(job.AppPath) != ".app" {
		return fmt.Errorf("app_path must be an absolute .app path, got %q", job.AppPath)
	}
	if !filepath.IsAbs(job.AsarPath) {
		return fmt.Errorf("asar_path must be absolute, got %q", job.AsarPath)
	}
	if !hexDigest.MatchString(job.Integrity) {
		return errors.New("integrity must be a sha256 hex digest")
	}
	if !hexDigest.MatchString(job.SHA256) {
		return errors.New("sha256 must be a sha256 hex digest")
	}
	return nil
}

func applyUpdate(job *UpdateJob) error {
	// Never touch a bundle the app might still have mapped.
	if job.WaitPID > 0 {
		if err := waitForExit(job.WaitPID, waitForExitTimeout); err != nil {
			return err
		}
	}

	// Re-verify here rather than trusting the staging step. This helper can be
	// invoked independently, and the payload has been sitting on disk since it
	// was written.
	payload, err := os.ReadFile(job.AsarPath)
	if err != nil {
		return fmt.Errorf("cannot read staged payload: %w", err)
	}
	if got := hex.EncodeToString(sha256Sum(payload)); got != job.SHA256 {
		return fmt.Errorf("staged payload digest %s does not match %s", got, job.SHA256)
	}

	asarPath := filepath.Join(job.AppPath, "Contents", "Resources", "app.asar")
	infoPath := filepath.Join(job.AppPath, "Contents", "Info.plist")

	// Backups must live OUTSIDE the bundle. A stray file under Contents/ is
	// treated by codesign as an unsigned subcomponent of the bundle, and signing
	// fails with "code object is not signed at all" naming the backup — so
	// keeping them beside the originals breaks the very step they exist to
	// protect.
	backupDir, err := os.MkdirTemp("", "focus-reader-update-")
	if err != nil {
		return fmt.Errorf("cannot create a backup directory: %w", err)
	}
	defer os.RemoveAll(backupDir)

	backupAsar := filepath.Join(backupDir, "app.asar")
	backupInfo := filepath.Join(backupDir, "Info.plist")
	if err := copyFile(asarPath, backupAsar); err != nil {
		return fmt.Errorf("cannot back up app.asar: %w", err)
	}
	if err := copyFile(infoPath, backupInfo); err != nil {
		return fmt.Errorf("cannot back up Info.plist: %w", err)
	}

	rollback := func(cause error) error {
		_ = copyFile(backupAsar, asarPath)
		_ = copyFile(backupInfo, infoPath)
		// A rollback that leaves the signature stale is still a broken app, so
		// re-sign the restored bundle. Safe to do here because the backups are
		// not inside the bundle being signed.
		_ = signAdHoc(job.AppPath)
		return cause
	}

	if err := writeFileAtomic(asarPath, payload); err != nil {
		return rollback(fmt.Errorf("cannot install app.asar: %w", err))
	}
	if err := setAsarIntegrity(infoPath, job.Integrity); err != nil {
		return rollback(fmt.Errorf("cannot set asar integrity: %w", err))
	}
	if err := signAdHoc(job.AppPath); err != nil {
		return rollback(fmt.Errorf("cannot re-sign bundle: %w", err))
	}
	if err := verifySignature(job.AppPath); err != nil {
		return rollback(fmt.Errorf("bundle failed verification after signing: %w", err))
	}

	return nil
}

// waitForExit blocks until pid is gone. Signal 0 probes for existence without
// delivering anything.
func waitForExit(pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return nil // gone, or not ours to signal
		}
		time.Sleep(waitPollInterval)
	}
	return fmt.Errorf("pid %d still running after %s", pid, timeout)
}

func setAsarIntegrity(infoPath, digest string) error {
	// PlistBuddy handles both binary and XML plists; Info.plist in a packaged
	// bundle is binary, so editing it as text is not an option.
	key := ":ElectronAsarIntegrity:Resources/app.asar:hash"
	cmd := exec.Command("/usr/libexec/PlistBuddy", "-c", "Set "+key+" "+digest, infoPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("PlistBuddy: %s", string(out))
	}
	return nil
}

func signAdHoc(appPath string) error {
	// Only the outer bundle changed; the frameworks and helpers keep the
	// signatures they shipped with, so --deep is neither needed nor wanted.
	cmd := exec.Command("/usr/bin/codesign", "--force", "--sign", "-", appPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("codesign: %s", string(out))
	}
	return nil
}

func verifySignature(appPath string) error {
	cmd := exec.Command("/usr/bin/codesign", "--verify", "--strict", appPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("codesign --verify: %s", string(out))
	}
	return nil
}

func sha256Sum(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

// writeFileAtomic replaces path via a temp file in the same directory, so a
// crash mid-write cannot leave a half-written asar behind.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".app.asar.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
