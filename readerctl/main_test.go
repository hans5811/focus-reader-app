package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeClaudeCodeDirectContent(t *testing.T) {
	payload := []byte(`{
		"session_id": "s1", "turn_id": "t1", "cwd": "/repo", "model": "claude-opus-5",
		"hook_event_name": "Stop", "last_assistant_message": "# Plan\n\nDo the thing."
	}`)
	env, err := Normalize("claude-code", payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env == nil {
		t.Fatal("expected an envelope")
	}
	if env.Content != "# Plan\n\nDo the thing." {
		t.Errorf("content = %q", env.Content)
	}
	if env.SessionID != "s1" || env.TurnID != "t1" || env.Cwd != "/repo" {
		t.Errorf("metadata not normalized: %+v", env)
	}
	if env.SchemaVersion != 1 || env.Source != "claude-code" {
		t.Errorf("envelope header wrong: %+v", env)
	}
	if env.SourceMetadata["hook_event_name"] != "Stop" {
		t.Errorf("source metadata missing: %+v", env.SourceMetadata)
	}
}

func TestNormalizeCodexContentBlocks(t *testing.T) {
	payload := []byte(`{
		"session_id": "abc", "prompt_id": "p9", "cwd": "/w", "model": "gpt-5",
		"last_agent_message": [{"type":"text","text":"first "},{"type":"text","text":"second"}]
	}`)
	env, err := Normalize("codex", payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env.Content != "first second" {
		t.Errorf("content = %q", env.Content)
	}
	if env.TurnID != "p9" {
		t.Errorf("turn id = %q", env.TurnID)
	}
}

func TestNormalizeMissingContentIsNoOp(t *testing.T) {
	for _, payload := range []string{`{}`, `{"session_id":"s"}`, `{"last_assistant_message":""}`, ``} {
		env, err := Normalize("claude-code", []byte(payload))
		if err != nil {
			t.Fatalf("payload %q: unexpected error %v", payload, err)
		}
		if env != nil {
			t.Errorf("payload %q: expected no-op, got %+v", payload, env)
		}
	}
}

func TestNormalizeMalformedPayloadIsAnError(t *testing.T) {
	if _, err := Normalize("codex", []byte("not json at all")); err == nil {
		t.Fatal("expected an error for malformed JSON")
	}
}

func TestNormalizeFallsBackToTranscript(t *testing.T) {
	dir := t.TempDir()
	transcript := filepath.Join(dir, "t.jsonl")
	lines := `{"message":{"role":"user","content":"hi"}}
{"message":{"role":"assistant","content":[{"type":"text","text":"earlier"}]}}
{"message":{"role":"assistant","content":"final answer"}}
`
	if err := os.WriteFile(transcript, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"transcript_path": transcript, "session_id": "s"})
	env, err := Normalize("claude-code", payload)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env == nil || env.Content != "final answer" {
		t.Fatalf("expected the last assistant message, got %+v", env)
	}
}

func TestEnqueueIsAtomicAndReadable(t *testing.T) {
	dir := t.TempDir()
	env := &Envelope{SchemaVersion: 1, Source: "codex", Content: "hello", CapturedAt: "2026-08-06T00:00:00Z"}
	if err := Enqueue(dir, env); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	ready, err := os.ReadDir(filepath.Join(dir, "inbox", "ready"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ready) != 1 {
		t.Fatalf("expected 1 ready file, got %d", len(ready))
	}

	// The temp staging directory must be left empty after the rename.
	tmp, err := os.ReadDir(filepath.Join(dir, "inbox", "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(tmp) != 0 {
		t.Errorf("expected tmp to be empty, got %d entries", len(tmp))
	}

	data, err := os.ReadFile(filepath.Join(dir, "inbox", "ready", ready[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var round Envelope
	if err := json.Unmarshal(data, &round); err != nil {
		t.Fatalf("ready file is not valid JSON: %v", err)
	}
	if round.Content != "hello" || round.Source != "codex" {
		t.Errorf("round trip lost data: %+v", round)
	}
}

func TestEnqueueDistinctNames(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 5; i++ {
		if err := Enqueue(dir, &Envelope{SchemaVersion: 1, Source: "codex", Content: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	ready, _ := os.ReadDir(filepath.Join(dir, "inbox", "ready"))
	if len(ready) != 5 {
		t.Fatalf("expected 5 distinct ready files, got %d", len(ready))
	}
}

func TestContentIsBoundedAndNeverExecuted(t *testing.T) {
	huge := make([]byte, maxContentBytes+2048)
	for i := range huge {
		huge[i] = 'a'
	}
	payload, _ := json.Marshal(map[string]any{"last_assistant_message": string(huge)})
	env, err := Normalize("claude-code", payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(env.Content) != maxContentBytes {
		t.Errorf("content not bounded: %d", len(env.Content))
	}
}
