// Command readerctl is Focus Reader's hook capture helper.
//
// It reads one coding-agent hook event from standard input, normalizes it into
// the schema-versioned envelope described in SPEC 10.2, and atomically enqueues
// it into the application inbox. It never parses Markdown, never calls an LLM,
// never executes captured content, and never blocks the coding agent: any
// recoverable problem is reported on stderr and exits 0.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"
)

const (
	schemaVersion = 1
	// Upper bound on a hook payload; anything larger is rejected safely.
	maxPayloadBytes = 32 << 20
	// Upper bound on captured content, matching the app's import limit.
	maxContentBytes = 10 << 20
	wakeTimeout     = 150 * time.Millisecond
)

// Envelope is the normalized capture record written to the inbox.
type Envelope struct {
	SchemaVersion  int               `json:"schema_version"`
	Source         string            `json:"source"`
	SourceVersion  string            `json:"source_version,omitempty"`
	SessionID      string            `json:"session_id,omitempty"`
	TurnID         string            `json:"turn_id,omitempty"`
	Cwd            string            `json:"cwd,omitempty"`
	Model          string            `json:"model,omitempty"`
	Content        string            `json:"content"`
	CapturedAt     string            `json:"captured_at"`
	SourceMetadata map[string]string `json:"source_metadata,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: readerctl ingest --source <claude-code|codex>")
		os.Exit(2)
	}

	switch os.Args[1] {
	case "ingest":
		os.Exit(runIngest(os.Args[2:]))
	case "apply-update":
		// Unlike ingest, this must report failure: nothing downstream depends on
		// it exiting 0, and a silent failure would leave the user on a stale
		// build believing they had updated.
		os.Exit(runApplyUpdate(os.Args[2:]))
	case "version":
		fmt.Println(version)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "readerctl: unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

var version = "1"

func runIngest(args []string) int {
	fs := flag.NewFlagSet("ingest", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	source := fs.String("source", "", "capture source: claude-code or codex")
	home := fs.String("home", "", "override the Focus Reader support directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *source != "claude-code" && *source != "codex" {
		fmt.Fprintln(os.Stderr, "readerctl: --source must be claude-code or codex")
		return 2
	}

	payload, err := readBounded(os.Stdin, maxPayloadBytes)
	if err != nil {
		// Never block the agent; the app records a redacted diagnostic instead.
		fmt.Fprintf(os.Stderr, "readerctl: unreadable hook payload (%v)\n", err)
		return 0
	}

	envelope, err := Normalize(*source, payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "readerctl: %v\n", err)
		return 0
	}
	if envelope == nil {
		// Missing assistant content is a successful no-op (SPEC 10.1).
		return 0
	}

	dir := supportDir(*home)
	if err := Enqueue(dir, envelope); err != nil {
		fmt.Fprintf(os.Stderr, "readerctl: could not enqueue capture (%v)\n", err)
		return 0
	}

	wake(dir)
	return 0
}

func readBounded(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("payload exceeds size limit")
	}
	return data, nil
}

func supportDir(override string) string {
	if override != "" {
		return override
	}
	if env := os.Getenv("FOCUS_READER_HOME"); env != "" {
		return env
	}
	base, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "Focus Reader")
	}
	return filepath.Join(base, "Library", "Application Support", "Focus Reader")
}

// Normalize converts a raw hook payload into an Envelope.
//
// It returns (nil, nil) when the event carries no assistant content, which is a
// successful no-op rather than an error.
func Normalize(source string, payload []byte) (*Envelope, error) {
	if len(payload) == 0 {
		return nil, nil
	}

	var raw map[string]any
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, fmt.Errorf("malformed hook payload: %d bytes were not JSON", len(payload))
	}

	content := extractContent(source, raw)
	if content == "" {
		return nil, nil
	}
	if len(content) > maxContentBytes {
		content = content[:maxContentBytes]
	}

	env := &Envelope{
		SchemaVersion: schemaVersion,
		Source:        source,
		SourceVersion: firstString(raw, "version", "source_version", "cli_version"),
		SessionID:     firstString(raw, "session_id", "sessionId", "conversation_id", "thread_id"),
		TurnID:        firstString(raw, "turn_id", "turnId", "prompt_id", "promptId", "message_id", "request_id"),
		Cwd:           firstString(raw, "cwd", "workspace_root", "working_directory", "project_dir"),
		Model:         firstString(raw, "model", "model_name"),
		Content:       content,
		CapturedAt:    time.Now().UTC().Format(time.RFC3339),
	}

	if meta := metadata(raw); len(meta) > 0 {
		env.SourceMetadata = meta
	}
	return env, nil
}

// contentKeys lists, in priority order, the documented fields that carry the
// final assistant message. Transcript reading is a deliberate last resort: the
// primary path is always a field the hook itself provides (SPEC 10.3, 10.4).
func contentKeys(source string) []string {
	if source == "codex" {
		return []string{
			"last_agent_message", "lastAgentMessage", "agent_message",
			"assistant_message", "final_message", "output", "content", "text",
		}
	}
	return []string{
		"last_assistant_message", "lastAssistantMessage", "assistant_message",
		"final_message", "response", "content", "text",
	}
}

func extractContent(source string, raw map[string]any) string {
	for _, key := range contentKeys(source) {
		if s := asMessageString(raw[key]); s != "" {
			return s
		}
	}
	// Nested message objects, e.g. {"message": {"content": "..."}}.
	for _, key := range []string{"message", "assistant", "result", "response"} {
		if nested, ok := raw[key].(map[string]any); ok {
			for _, inner := range []string{"content", "text", "message"} {
				if s := asMessageString(nested[inner]); s != "" {
					return s
				}
			}
		}
	}
	if path := firstString(raw, "transcript_path", "transcriptPath"); path != "" {
		return lastAssistantFromTranscript(path)
	}
	return ""
}

// asMessageString accepts a plain string or the content-block array shape used
// by assistant messages, concatenating text blocks in order.
func asMessageString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		out := ""
		for _, item := range v {
			switch block := item.(type) {
			case string:
				out += block
			case map[string]any:
				if t, ok := block["type"].(string); ok && t != "text" {
					continue
				}
				if s, ok := block["text"].(string); ok {
					out += s
				}
			}
		}
		return out
	}
	return ""
}

func firstString(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		if s, ok := raw[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func metadata(raw map[string]any) map[string]string {
	out := map[string]string{}
	for _, key := range []string{"hook_event_name", "permission_mode", "source", "reason"} {
		if s, ok := raw[key].(string); ok && s != "" {
			out[key] = s
		}
	}
	return out
}

// lastAssistantFromTranscript is the fallback path for hook versions that pass
// only a transcript location. It reads the JSONL transcript and returns the
// final assistant message, or "" if it cannot be determined.
func lastAssistantFromTranscript(path string) string {
	info, err := os.Stat(path)
	if err != nil || info.Size() > maxPayloadBytes {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	found := ""
	for _, line := range splitLines(data) {
		if len(line) == 0 {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		msg, ok := entry["message"].(map[string]any)
		if !ok {
			continue
		}
		if role, _ := msg["role"].(string); role != "assistant" {
			continue
		}
		if s := asMessageString(msg["content"]); s != "" {
			found = s
		}
	}
	return found
}

func splitLines(data []byte) [][]byte {
	var out [][]byte
	start := 0
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			out = append(out, data[start:i])
			start = i + 1
		}
	}
	if start < len(data) {
		out = append(out, data[start:])
	}
	return out
}

// Enqueue writes the envelope to a uniquely named temporary file, flushes it,
// and atomically renames it into the ready directory (SPEC 10.5).
func Enqueue(supportDir string, env *Envelope) error {
	tmpDir := filepath.Join(supportDir, "inbox", "tmp")
	readyDir := filepath.Join(supportDir, "inbox", "ready")
	for _, dir := range []string{tmpDir, readyDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}

	data, err := json.Marshal(env)
	if err != nil {
		return err
	}

	file, err := os.CreateTemp(tmpDir, "capture-*.json")
	if err != nil {
		return err
	}
	tmpPath := file.Name()
	defer os.Remove(tmpPath) // no-op once the rename succeeds

	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}

	name := fmt.Sprintf("%d-%s.json", time.Now().UTC().UnixNano(), filepath.Base(tmpPath))
	return os.Rename(tmpPath, filepath.Join(readyDir, name))
}

// wake nudges a running Focus Reader to import immediately. Failure is fine:
// the app imports anything already in the inbox at next launch.
func wake(supportDir string) {
	conn, err := net.DialTimeout("unix", filepath.Join(supportDir, "readerctl.sock"), wakeTimeout)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetWriteDeadline(time.Now().Add(wakeTimeout))
	conn.Write([]byte("wake\n"))
}
