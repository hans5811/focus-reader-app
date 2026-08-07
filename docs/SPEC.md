# Focus Reader for macOS

## Complete product and technical specification

**Status:** Implementation specification  
**Version:** 2.0  
**Date:** 2026-08-06  
**Working name:** Focus Reader  
**Target stack:** Electron, React, TypeScript, SQLite, and a small Go capture helper

---

## 1. Product definition

Focus Reader is a local-first, menu-bar-first macOS application for reading long technical documents and completed responses from coding agents. Its primary surface is a floating RSVP overlay rather than a conventional application window.

RSVP, or rapid serial visual presentation, displays one prose word at a time around a fixed optimal-recognition point. Technical content is preserved as meaningful intact units. Paths, identifiers, short expressions, declarations, and function calls receive additional display time according to their visual and semantic complexity.

Examples of intact technical units include:

- `station_record_id`
- `Decimal(9, 3)`
- `SensorReading(BaseModel):`
- `services/ingest/models/station_registry.py`

The overlay also shows the active Markdown heading hierarchy, nearby sentence context, document progress, and syntax-aware treatment of code. A secondary Library window exists for history, capture setup, preferences, search, and full-document browsing, but it does not open on launch.

### Product promise

> Turn a wall of agent-generated technical text into a paced and navigable reading session without summarizing, rewriting, or losing the source.

### Core principles

1. **Overlay first:** Summoning the reader is the normal experience; opening a main window is exceptional.
2. **Source fidelity:** Preserve the original input byte-for-byte and keep every reading unit traceable to it.
3. **Fixed visual focus:** The recognition pivot remains at a stable screen coordinate while words change around it.
4. **Technical meaning over whitespace:** Keep coherent code, paths, and symbols intact.
5. **Context without a wall of text:** Show nearby words, nearby sentences, headings, and progress without competing with the focused unit.
6. **Local and deterministic:** Parsing, unitization, timing, and capture require neither an LLM nor a cloud service.
7. **Menu-bar away-ness:** The application stays available without occupying the Dock or opening a window at launch.
8. **Explicit interaction states:** Focused reading and passive click-through behavior have distinct, predictable keyboard rules.

---

## 2. Target user and jobs

The primary user is a developer who receives long plans, reviews, explanations, migration notes, and debugging reports from terminal-based coding agents such as Claude Code and Codex.

The product helps the user:

- Start reading clipboard text with one shortcut.
- Start reading the latest captured agent response with a different shortcut.
- Read while retaining section, sentence, and technical context.
- Understand code without breaking syntax into meaningless fragments.
- Keep a lightweight reader above a terminal, editor, or browser.
- Find and resume previously captured material.
- Verify any presented unit against the unmodified source.

Representative documents include implementation plans, code reviews, architecture explanations, test-failure analysis, PR summaries, database migrations, and security findings.

---

## 3. Product scope

### 3.1 MVP

- Menu-bar-only launch behavior on macOS.
- Two independently configurable global entry shortcuts.
- Document Mode for clipboard text.
- Agent Response Mode for the latest captured Claude Code or Codex response.
- Four selectable overlay layouts: Compact, Docked Rail, Peek, and Expanded.
- RSVP playback with a fixed optimal-recognition-position pivot.
- Same-sentence word context horizontally around the focused word.
- Previous and next sentence context vertically above and below it.
- Persistent H1–H6 context in the upper-left.
- Header-delineated document progress.
- Markdown and plain-text import.
- Syntax-aware presentation of fenced and inline code.
- Technical tokenization and proportional dwell timing.
- Claude Code and Codex completed-response capture.
- Local Library and full-document Browse view.
- Search, reading-position restoration, and original-source view.
- Global playback controls for passive and click-through operation.

### 3.2 Explicitly out of scope for MVP

- Live generation streaming.
- Editing repository files or executing commands from a response.
- Cloud synchronization or collaboration.
- LLM-generated summaries presented as source truth.
- Full coding-agent conversation replay.
- Windows, Linux, iOS, or iPadOS clients.
- Hiding the overlay from screenshots, recordings, screen sharing, the Dock, process inspection, or accessibility APIs.
- Any stealth, interview-assistance, or “undetectable” behavior.

---

## 4. Application architecture and lifecycle

### 4.1 Menu-bar-first application

Focus Reader launches as a menu-bar application:

- No Library or other ordinary window opens at login or manual launch.
- No Dock icon is shown during ordinary menu-bar operation.
- Clicking the menu-bar icon always opens a popover or menu.
- The overlay may appear without opening the Library.
- Closing the Library returns the app to menu-bar operation rather than quitting.
- Quit is an explicit menu action.

The menu-bar popover contains:

- Read Clipboard
- Read Latest Agent Response
- Resume Current Document
- Overlay Layout submenu
- Click-through toggle
- Pin toggle
- Library
- Capture & Setup
- Preferences
- Quit

The icon must expose an accessible label and both left-click and keyboard activation. Menu construction, click handling, app activation policy, and shortcut registration require automated smoke tests and a manual test on a signed build.

### 4.2 Entry-point modes

#### Document Mode

Document Mode is invoked by its own global shortcut or **Read Clipboard** menu action.

On invocation:

1. Read the current clipboard as a direct consequence of the user action.
2. Accept non-empty plain text or Markdown.
3. Import or deduplicate the document.
4. Parse and unitize it.
5. Open the overlay at the first unread position, or the first unit for a new document.
6. Give the reading session keyboard focus immediately.

The MVP does not continuously monitor the clipboard. Empty, binary, image-only, or unsupported clipboard content produces a quiet, actionable error.

#### Agent Response Mode

Agent Response Mode is invoked by a separate global shortcut or **Read Latest Agent Response** menu action. “Claude Response Mode” may be used as an early UI label, but the underlying mode supports both Claude Code and Codex.

On invocation:

1. Select the most recently captured valid agent response across enabled sources.
2. If it is already open, resume its stored position.
3. Otherwise parse it and begin at its first reading unit.
4. Open and focus the overlay immediately.

A preference may restrict this action to Claude Code, Codex, the current repository, or unread responses. The MVP default is the newest response from either supported agent.

### 4.3 Keyboard focus contract

There are two deliberately different overlay states:

**Focused reading session**

- Created by either entry shortcut, Resume, or an explicit click into the overlay.
- Receives Space, arrow keys, and other unmodified reading keys immediately; no preliminary click is required.
- May activate Focus Reader while open.
- Escape dismisses the session from every layout, stops keyboard capture, and restores the previously active application where macOS permits.

**Passive overlay**

- Remains visible while another application owns keyboard focus.
- May continue playback.
- Does not consume bare Space or arrow keys.
- Is controlled using configurable chorded global shortcuts.
- May be interactive with the pointer or fully click-through.

Bare Space and arrows must never be registered as system-wide shortcuts. This avoids breaking editors, terminals, browsers, and media controls.

---

## 5. Overlay experience

### 5.1 Shared overlay anatomy

Every persistent layout is rendered from one shared `ReadingStage` component and the same playback state. Layouts may rearrange or hide optional elements, but they must not implement separate token, pivot, timing, context, or progress logic.

The stage contains:

1. Heading context in the upper-left.
2. Previous sentence above the word row.
3. Same-sentence word row with the focused unit at the fixed pivot.
4. Next sentence below the word row.
5. Parenthetical or technical secondary context when applicable.
6. Header-delineated progress.
7. Optional transport controls and timing information.

### 5.2 Layouts

#### Compact

The default layout. Target minimum size: 560 × 260 points.

- Heading stack in the upper-left.
- Full three-axis context presentation.
- Thin segmented progress bar.
- Controls appear on pointer entry or keyboard interaction.

#### Docked Rail

Snaps to the left or right edge of the current display.

- Target width: 320–440 points.
- Context is compressed but the focused word remains in an inline horizontal word row.
- Long technical units may wrap at safe visual boundaries while remaining one timed unit.
- Heading stack may collapse middle ancestors when space is constrained.

#### Peek

A temporary, minimal view used to inspect the current state.

- Shows heading context, focused unit, and progress.
- Does not reset playback or reading position.
- Dismisses on shortcut release, Escape, or a configured timeout.
- Does not replace Compact as the persisted layout.

#### Expanded

The full reading surface without opening the Library.

- Shows transport controls, WPM, technical slowdown, estimated time, and section navigation.
- Shows the same horizontal word row and vertical sentence context as Compact.
- Never reverts to a stacked previous-word/current-word/next-word presentation.
- Supports resizing and exposes the layout switcher.

### 5.3 Layout switching

All four layouts must be reachable through:

- Menu-bar **Overlay Layout** submenu.
- A visible layout control in Expanded mode.
- Overlay context menu.
- Configurable **Cycle Layout** keyboard shortcut.

The selected persistent layout is restored after relaunch. Peek is transient and returns to the previously selected layout.

### 5.4 Window behavior

The overlay must:

- Be borderless and optionally translucent.
- Stay above ordinary windows when pinned.
- Support pointer-interactive and click-through states.
- Support all macOS Spaces and full-screen-adjacent presentation where the OS permits it.
- Remember layout, size, position, opacity, pinning, and dock edge per display.
- Move to the display containing the pointer when summoned unless display-pinned.
- Recover onto a visible display after monitor disconnection.
- Continue playback while another app is active.
- Pause when the screen locks or sleeps.
- Remain visible in ordinary screenshots and screen sharing.

### 5.5 Heading context

The current Markdown hierarchy is always visible in the upper-left of Compact, Docked Rail, and Expanded:

```text
Sensor pipeline: unified readings schema
  batch_ids replace run_labels
    SensorReading
```

Requirements:

- Support H1 through H6.
- Show the active ancestor chain plus the current deepest heading.
- Encode hierarchy through indentation, type scale, opacity, and accessible level labels.
- Highlight the deepest active heading.
- Update before the first content unit of a new section appears.
- Remain visible while paused and while stepping.
- Truncate visually only when necessary; expose complete text by hover, focus, or accessibility label.
- If no headings exist, show a derived document title only.

### 5.6 Three-axis reading context

The focused unit occupies a fixed screen coordinate. Surrounding context must not move that coordinate.

```text
             Previous sentence, subdued and centered

       earlier words   FOCUSED   later words
                       ^ pivot

                Next sentence, more subdued
```

Requirements:

- Previous and next **words from the same sentence** appear horizontally inline with the focused unit.
- Previous words appear to its left; next words appear to its right.
- Previous and next **whole sentences** appear as separate vertical lines above and below.
- Context words do not animate through the pivot and never become mistaken for the current unit.
- Context opacity falls with distance from the current unit.
- The focused unit’s pivot stays fixed even as context lengths change.
- Context must be correct in Compact, Docked Rail, and Expanded.
- Users may independently disable word context and sentence context.

Default context quantities:

- Up to three previous and three next same-sentence words.
- One previous and one next sentence, truncated visually to a configurable character limit.

### 5.7 Parenthetical content

Parentheses have two distinct meanings and must not share one brittle display rule.

**Technical delimiter:** Parentheses inside an intact technical unit, such as `Decimal(9, 3)`, remain part of that unit and use normal technical styling.

**Prose aside:** A balanced prose span such as `(inferred from the payload)` is annotated across all of its word units. While those units play:

- The words continue to advance normally through the fixed pivot.
- The entire parenthetical span is represented on a quieter secondary lane.
- Parenthetical units use reduced visual emphasis without becoming unreadable.
- Opening and closing punctuation remain visible at the span boundaries.
- Timing receives a small parenthetical multiplier rather than collapsing the aside into one giant unit.
- Nested and unmatched parentheses degrade safely to ordinary prose.

Parenthetical recognition must be span-based; it must not depend on both parentheses occurring inside a single token.

### 5.8 Progress

The progress surface shows:

- Current reading-unit index and total units.
- Overall completion.
- Estimated time remaining from actual scheduled dwell durations.
- Markdown heading boundaries when headings exist.

Each heading creates a marker at its first unit. Marker hierarchy is encoded as follows:

- H1: strongest divider.
- H2: major divider.
- H3–H6: progressively quieter ticks.
- Closely spaced minor markers may aggregate visually, but remain available through section navigation and accessibility.
- The active section range and current heading marker are highlighted.

Plain-text documents use an uninterrupted progress bar.

### 5.9 Controls

Focused-session keys:

| Key | Action |
|---|---|
| Space | Play or pause |
| Left / Right | Previous or next unit |
| Option + Left / Right | Previous or next heading |
| Up / Down | Increase or decrease WPM by 25 |
| R | Restart current section |
| L | Cycle overlay layout |
| B | Open Browse view at current source position |
| Escape | Dismiss overlay and restore prior app |

Proposed global defaults:

| Action | Default |
|---|---|
| Document Mode | Control + Option + D |
| Agent Response Mode | Control + Option + A |
| Show/hide current overlay | Control + Option + Space |
| Global play/pause | Control + Option + P |
| Global previous/next unit | Control + Option + Left/Right |
| Global previous/next heading | Control + Option + Shift + Left/Right |
| Toggle click-through | Control + Option + T |
| Cycle persistent layout | Control + Option + L |

All shortcuts are configurable. Registration failures and conflicts must be shown in Capture & Setup with a direct rebinding action.

---

## 6. Recognition pivot and typography

### 6.1 Optimal recognition position

The focused unit is aligned by an optimal-recognition-position character rather than centered by its full bounding box.

Default pivot index by grapheme count:

| Length | Pivot index, zero-based |
|---:|---:|
| 1 | 0 |
| 2–5 | 1 |
| 6–9 | 2 |
| 10–13 | 3 |
| 14+ | approximately 30% of grapheme count |

The renderer measures the prefix before the pivot and offsets the unit so the pivot glyph lands on the fixed screen coordinate. A vertical guide or notch may be shown. The pivot glyph uses an accent color, but fixed placement—not color—is the essential behavior.

Punctuation is excluded when choosing the linguistic pivot where practical, but remains in the rendered unit. Technical units use the same stable pivot algorithm unless a syntax-specific pivot is available.

### 6.2 Typography

- Prose uses a highly legible proportional system font.
- Technical units use a monospaced font.
- The focused unit has the strongest contrast.
- Same-sentence context is smaller and quieter.
- Adjacent-sentence context is quieter again.
- Syntax colors must meet contrast requirements and are never the only signal of token type.
- Long technical units shrink only to a configurable minimum size, then wrap at safe boundaries without semantic truncation.

---

## 7. Content model and parsing

### 7.1 Source preservation

Every import stores:

- Exact original text.
- Source and capture metadata.
- Parsed Markdown tree.
- Source ranges for every block and inline node.
- Derived sentences, spans, entities, and reading units.
- Parser and unitizer versions.

Reparsing never overwrites the original source.

### 7.2 Markdown model

Parse headings H1–H6, paragraphs, ordered and unordered lists, task items, blockquotes, fenced and indented code, tables, thematic breaks, links, inline code, emphasis, and strong emphasis. Malformed Markdown degrades to readable plain text.

### 7.3 Heading state

During linear traversal, encountering a heading at level `n` removes stored headings at level `n` and deeper, then stores the new heading. The resulting active stack is precomputed onto all subsequent units until the next heading transition.

### 7.4 Sentences and spans

The parser derives sentence ranges before word context is produced. It also records balanced prose-parenthetical spans across token boundaries. Every reading unit references:

- Its sentence.
- Previous and next unit in that sentence.
- Previous and next sentence.
- Any containing parenthetical span.
- Its active heading stack.

### 7.5 Technical recognition

Deterministically recognize:

- POSIX, Windows, and repository-relative paths.
- Known filenames and extensions.
- `snake_case`, `camelCase`, and `PascalCase` identifiers.
- Dotted and namespaced symbols.
- Function and method calls.
- Type annotations, short assignments, and declarations.
- Shell commands, flags, and environment variables.
- URLs, UUIDs, hashes, versions, database names, and code-marked schema entities.

Recognition annotates source text; it does not rewrite it.

### 7.6 Reading-unit generation

#### Prose

- Use Unicode-aware word and sentence boundaries.
- Keep contractions, decimal numbers, and version numbers intact.
- Attach trailing punctuation to the word.
- Record parenthetical membership separately from token text.

#### Inline code

Keep short inline expressions intact. If an expression cannot fit at the minimum technical size, split only at syntax-safe, high-level boundaries while retaining source mapping.

#### Paths

- Keep the full path as one timed unit.
- Never split directories into independent RSVP units.
- Allow visual wrapping at path separators only after minimum scaling is reached.
- Preserve complete text for copy and accessibility.

#### Code blocks

Use a syntax highlighter that returns token ranges, with deterministic lexical fallback for unsupported languages. Generate meaningful units such as declarations, signatures, typed fields, balanced calls, literals, comments, and short expressions.

Code blocks retain language, line number, source range, and syntax-token metadata. The user can select declaration-sized or smaller lexical units.

---

## 8. Timing model

### 8.1 Base interval

```text
baseMilliseconds = 60,000 / selectedWPM
```

At 300 WPM, the base interval is 200 ms.

### 8.2 Visual-length factor

Calculate visual length from Unicode grapheme clusters:

- Letters and digits: `1.0`
- Uppercase wide glyphs: `1.05`
- `_`, `.`, `-`, `/`, `\`, and punctuation: `0.55`
- Whitespace inside technical units: `0.5`
- Full-width graphemes: `1.8`

```text
lengthFactor = clamp(
  1.0,
  2.75,
  1 + max(0, visualLength - 8) * 0.035
)
```

### 8.3 Multipliers

| Unit type | Multiplier |
|---|---:|
| Ordinary prose | 1.00 |
| Parenthetical prose | 1.08 |
| Identifier | 1.15 |
| Code expression | 1.20 |
| Declaration | 1.25 |
| File path | 1.35 |
| Heading | 1.60 |

| Boundary | Multiplier |
|---|---:|
| Comma or semicolon | 1.15 |
| Sentence end | 1.45 |
| Paragraph/list end | 1.35 |
| Code-line end | 1.20 |
| New subsection | 1.45 |
| New major section | 1.70 |

### 8.4 Section-entry ramp

After a heading, playback must not jump directly into ordinary full-speed text:

1. Display the complete heading with heading dwell.
2. Apply the section boundary multiplier to the first content unit.
3. Apply a smaller `1.20` ramp multiplier to the second content unit.
4. Return to ordinary timing on the third unit.

### 8.5 Final dwell

```text
dwellMilliseconds = clamp(
  80,
  2500,
  baseMilliseconds
    * lengthFactor
    * typeMultiplier
    * boundaryMultiplier
    * entryRampMultiplier
)
```

At 300 WPM, `services/ingest/models/station_registry.py` must remain intact and receive materially more time than an ordinary word, with a target range of approximately 500–800 ms after calibration.

User preferences include WPM from 100–700, technical slowdown from 1.0–2.0×, heading pause, sentence pause, and section-entry pause.

---

## 9. Library, Browse, and Setup

### 9.1 Library

Library is opened only from the menu bar, overlay command, or notification. It shows title, source, repository, capture time, progress, and read state. Documents can be grouped by date, source, or repository and searched locally.

### 9.2 Browse view

Browse displays the complete rendered document with:

- Document list.
- Collapsible heading outline.
- Formatted Markdown and syntax-highlighted code.
- Current source position.
- **Read from here** on headings, paragraphs, list items, and code blocks.
- Selection and copy.
- Original-source view.
- User-initiated Reveal in Finder and Open in Editor actions for recognized paths.

### 9.3 Capture & Setup

Capture & Setup shows:

- Claude Code and Codex hook status.
- Last successful capture and last redacted error.
- Install, verify, repair, and remove actions.
- Exact configuration file and proposed modification before changes.
- Backup status and manual configuration instructions.
- Global shortcut registration and conflicts.
- A test-capture action for each source.

---

## 10. Agent integrations

### 10.1 Integration contract

A bundled Go executable named `readerctl` reads one hook event from standard input, normalizes it, atomically enqueues it, optionally wakes the app, and exits.

It must:

- Finish under 500 ms in ordinary conditions.
- Work when the Electron process is not running.
- Never parse Markdown or invoke an LLM.
- Print nothing to stdout on success.
- Treat missing assistant content as a successful no-op.
- Bound payload size and reject malformed input safely.
- Never execute or interpolate captured content.

### 10.2 Normalized envelope

```json
{
  "schema_version": 1,
  "source": "codex",
  "source_version": "...",
  "session_id": "...",
  "turn_id": "...",
  "cwd": "/path/to/repository",
  "model": "...",
  "content": "# Completed assistant response...",
  "captured_at": "2026-08-06T14:31:00Z",
  "source_metadata": {}
}
```

Deduplicate by `source + session_id + turn_id/prompt_id`. If the turn identifier is absent, use `source + session_id + SHA-256(cwd + content)`.

### 10.3 Claude Code

Use the Claude Code `Stop` hook and ingest the documented final assistant message plus session and working-directory metadata. Do not scrape terminal output. Do not use transcript parsing as the primary path. A stopped or failed turn may not yield a valid final response and must safely no-op or be recorded as a capture diagnostic.

Representative command:

```text
/Applications/Focus Reader.app/Contents/Resources/bin/readerctl ingest --source claude-code
```

### 10.4 Codex

Use the documented Codex completed-turn/`Stop` hook surface and ingest the final assistant message plus available session, turn, model, and working-directory metadata. Treat nullable content as a no-op and do not depend on unstable transcript paths.

Representative command:

```text
/Applications/Focus Reader.app/Contents/Resources/bin/readerctl ingest --source codex
```

### 10.5 Queue delivery

1. Write a uniquely named temporary JSON file to the application inbox.
2. Flush where practical.
3. Atomically rename it into the ready directory.
4. Attempt a lightweight app wake notification without requiring success.
5. Exit successfully.
6. Import ready events idempotently when the app is running or next launches.

Hook installation must merge with existing configuration, preserve unrelated settings, create a backup, and require explicit user approval.

---

## 11. Technical architecture

### 11.1 Stack

- Electron main process for application lifecycle, menu bar, global shortcuts, windows, Spaces, display management, and filesystem coordination.
- React and TypeScript renderer for Overlay, Library, Browse, and Setup.
- Shared framework-independent TypeScript packages for parsing, unitization, timing, context, and playback state.
- SQLite with FTS5 for local persistence and search.
- Go `readerctl` helper for hook capture.
- A maintained Markdown AST implementation and syntax highlighter with deterministic fallbacks.

No Swift or SwiftUI component is required for the MVP. A narrowly scoped native module may be introduced later only for a macOS behavior that Electron cannot satisfy and must have its own contract tests.

### 11.2 Process boundaries

```text
Claude Code / Codex
        |
        v
Go readerctl -> atomic inbox
                    |
                    v
Electron main process
  |       |        |
  |       |        +-- SQLite / search / imports
  |       +----------- menu bar / shortcuts
  +------------------- overlay and Library windows
                           |
                           v
              sandboxed React renderers
                           |
                           v
              shared TypeScript reading engine
```

### 11.3 Electron security

- `nodeIntegration: false`.
- `contextIsolation: true`.
- Renderer sandbox enabled.
- A small preload bridge exposes an allowlisted, typed IPC API.
- No renderer access to arbitrary filesystem or process APIs.
- Validate all IPC payloads in the main process.
- Render captured Markdown as sanitized local content.
- Block remote navigation, popup creation, and arbitrary script execution.
- Never concatenate captured text into a shell command.

### 11.4 Window implementation

Use separate BrowserWindows for the overlay and Library. The overlay window service owns:

- Always-on-top state.
- Focusable versus passive presentation.
- Ignored mouse events for click-through.
- Visibility on all workspaces and full-screen-adjacent behavior.
- Opacity, bounds, display recovery, and layout persistence.
- Escape dismissal and previous-application restoration.

Window policy lives in the main process, not React components.

### 11.5 Shared reading state

A single state machine controls every layout:

```text
closed -> focused.paused -> focused.playing
   |            |                 |
   +------ passive.paused <-> passive.playing
                    |
                    +-> peek -> previous persistent state
```

State includes document ID, unit index, playback status, heading stack, context references, scheduled dwell, persistent layout, interaction mode, and active display. Changing layout must not recreate or advance the playback clock.

### 11.6 Storage

Core tables:

- `documents`: source, session, turn, repository, raw content, hash, capture time, parser versions, progress.
- `headings`: level, text, source range, first unit.
- `sentences`: source range and neighboring sentence IDs.
- `reading_units`: display text, kind, source range, sentence, visual length, timing factors, heading stack, parenthetical span.
- `entity_annotations`: kind, value, source range, metadata.
- `capture_events`: source envelope, deduplication key, import state, redacted error.
- `preferences`: shortcuts, layout, timing, display, and context settings.

Do not load all units from all documents into memory. Prefetch a bounded window around the active unit.

---

## 12. Import behavior

### Clipboard

- Read only on explicit Document Mode invocation or paste action.
- Preserve clipboard text exactly.
- Detect Markdown heuristically without rewriting it.
- Reject empty or non-text content clearly.

### Files

- Support `.md`, `.markdown`, and `.txt` through Browse/Library.
- Support drag-and-drop and Finder Open With.
- Default maximum input size: 10 MB.
- Reject binary content without losing the source reference.

### Hook captures

- Import automatically and quietly.
- Never steal focus on capture by default.
- Optionally show a local notification.
- Optionally auto-summon the overlay, disabled by default.
- Make the response immediately available to Agent Response Mode.

---

## 13. Accessibility and privacy

### Accessibility

- Full keyboard operation.
- VoiceOver labels for focused unit, pivot, unit type, position, heading stack, sentences, and controls.
- Respect Reduce Motion and Increased Contrast.
- Never encode syntax, hierarchy, or state using color alone.
- Provide Browse as a complete non-RSVP alternative.
- Expose a command to leave click-through mode.
- Allow recognition-pivot highlighting and contextual lanes to be disabled independently.

### Privacy and security

- No document content leaves the Mac in the MVP.
- No content-bearing analytics.
- Redact documents, prompts, code, paths, and identifiers from diagnostics.
- Optional aggregate telemetry is opt-in.
- Provide per-document deletion, delete-all, and retention controls.
- Treat captured text and metadata as untrusted input.
- Show and back up hook configuration before editing it.
- The overlay remains an ordinary inspectable and capturable app surface.

---

## 14. Performance requirements

- Global entry shortcut to visible overlay: under 120 ms p95 while the app is resident.
- Menu-bar click to visible popover: under 100 ms p95.
- Hook enqueue for a 1 MB response: under 500 ms p95.
- Previously parsed document to playable state: under 250 ms p95.
- Parse and unitize 100,000 words: under 3 seconds p95 without blocking the renderer.
- RSVP visual transition jitter: under 16 ms excluding intentional dwell.
- Search across 10,000 documents: under 150 ms p95.
- Layout switching: under 100 ms without losing unit position or playback phase.
- Idle memory target: under 250 MB after initial optimization; report regressions in CI.

---

## 15. Error handling

- **Empty clipboard:** Keep the current session unchanged and show a quiet error.
- **No captured response:** Explain how to configure or test capture.
- **Shortcut conflict:** Preserve the old valid shortcut and offer rebinding.
- **App unavailable during hook:** Queue for the next launch.
- **Malformed hook event:** Record a redacted error and never block the coding agent.
- **Duplicate event:** Return success without creating another document.
- **Parser failure:** Preserve and display the original as plain text with retry.
- **Configuration conflict:** Do not overwrite the settings file; show a merge preview or manual snippet.
- **Display removed:** Relocate the overlay to a visible display.
- **Syntax language unsupported:** Use escaped monospaced text and lexical unitization.

---

## 16. Acceptance criteria

### Menu bar and entry points

- Launching Focus Reader shows a menu-bar item and no ordinary window.
- Clicking the menu-bar icon always opens its popover/menu.
- Document Mode reads current clipboard text and opens the overlay.
- Agent Response Mode opens the newest captured Claude Code or Codex response.
- Both entry modes have independently configurable working global shortcuts.
- Shortcut-registration failure is visible and recoverable.
- Library and Capture & Setup are reachable from the menu bar.

### Focus and dismissal

- Immediately after either entry shortcut, Space plays or pauses without clicking the overlay.
- Left and Right step units without clicking first.
- Escape dismisses Compact, Docked Rail, Peek, and Expanded.
- Dismissal restores the previously active app where macOS allows it.
- Passive mode never captures bare Space or arrows globally.
- Chorded global playback shortcuts work when another app is active.

### RSVP and recognition pivot

- The focused pivot character stays at the same screen coordinate across varying word lengths.
- Pivot placement is correct with leading and trailing punctuation.
- Turning off pivot color does not change fixed alignment.
- Ordinary prose displays one word per timed unit.
- `station_record_id`, `Decimal(9, 3)`, and `services/ingest/models/station_registry.py` each display intact.
- The long path has a longer dwell than a short prose word at equal WPM.
- New sections receive heading dwell and a two-unit entry ramp.
- Pause, step, resume, and layout switching never change unit order.

### Context

- Same-sentence previous and next words are inline horizontally with the focused unit.
- Previous and next sentences are separate vertical lanes.
- The focused pivot does not move as horizontal context changes.
- Compact, Docked Rail, and Expanded all use the same inline word-row behavior.
- Expanded contains no legacy stacked previous/current/next word implementation.
- `(inferred from the payload)` is recognized as one prose-parenthetical span across multiple units and receives quiet secondary treatment throughout.
- `Decimal(9, 3)` remains a technical unit and is not treated as a prose aside.

### Headings and progress

- H1–H6 render correctly in Browse.
- The correct ancestor chain is visible in the overlay upper-left.
- Heading context updates before the first unit in the new section.
- Progress includes appropriately weighted markers for every Markdown heading level.
- Current section and overall position agree with Browse mode.
- Documents without headings show an uninterrupted progress bar.

### Layouts and overlay

- Compact, Docked Rail, Peek, and Expanded are all reachable without editing preferences files.
- Layout can be changed from the menu bar, overlay, and shortcut.
- Layout switching preserves document, unit, playback state, and dwell schedule.
- Selected persistent layout restores after relaunch.
- Click-through passes pointer events to the underlying app.
- Pinned overlay remains above ordinary windows.
- Bounds and layout restore per display, and off-screen bounds recover.
- Long paths remain complete and identically timed in every layout.
- The overlay remains visible in ordinary screenshots and screen sharing.

### Capture and fidelity

- A completed Claude Code response and a completed Codex response each import once.
- Captured final content is not derived by scraping visible TUI output.
- Capture does not block the agent if Focus Reader is unavailable.
- Existing unrelated hook configuration survives installation and repair.
- Original source remains available byte-for-byte.
- Every reading unit maps back to a source range.

---

## 17. Test plan

### Unit tests

- H1–H6 stack transitions.
- Unicode word and sentence boundaries.
- Balanced, nested, and unmatched prose parentheses.
- Technical parentheses versus prose asides.
- Paths, identifiers, commands, and code expressions.
- Pivot-index selection and pixel offset from measured glyph runs.
- Visual length and dwell snapshots at multiple WPM settings.
- Section-entry ramp.
- Context-neighbor selection at sentence and document boundaries.
- Capture normalization and deduplication.
- Hook-settings merge behavior.

### Fixture corpus

Maintain a checked-in test document that includes:

- Deep H1–H6 nesting and repeated heading-level jumps.
- Long prose with multiple sentences.
- `(inferred from the payload)` and nested or unmatched parentheses.
- `Decimal(9, 3)` and other technical delimiters.
- Python, Swift, TypeScript, SQL, shell, JSON, and TOML.
- `services/ingest/models/station_registry.py` and longer paths.
- Tables, blockquotes, lists, URLs, UUIDs, and malformed Markdown.
- Unicode, emoji, combining marks, and CJK.
- At least one response larger than 1 MB.

Include `reflective-hatching-quasar.md` as a manual or copied licensed fixture when available; automated tests must not depend on a file remaining in Downloads.

### State-machine tests

- Summon into focused paused and focused playing states.
- Escape from all layouts and playback states.
- Focused-to-passive transition.
- Pointer-interactive to click-through transition.
- Peek and return to prior persistent layout.
- Layout switch during an active dwell without double advancement.

### Integration tests

- Pipe representative Claude Code and Codex hook events into `readerctl`.
- Verify atomic queue creation and delayed import.
- Verify duplicates, empty content, malformed payload, and unavailable app.
- Test menu-bar actions and shortcut registration in a packaged macOS build.
- Test renderer/main IPC rejection for invalid payloads.

### Visual and UI tests

- Snapshot Compact, Docked Rail, and Expanded at short and long word lengths.
- Assert pivot coordinate within a small pixel tolerance.
- Assert same-sentence context shares the current word row in every persistent layout.
- Assert sentence lanes remain above and below.
- Assert H1–H6 progress markers and upper-left hierarchy.
- Test syntax highlighting, parenthetical spans, light/dark appearance, Reduce Motion, Increased Contrast, and large text.
- Manually test real Escape, Space, and arrow key events; synthetic events alone are insufficient for focus verification.
- Manually test Terminal, iTerm, VS Code, Xcode, multiple Spaces, full-screen apps, and monitor disconnect/reconnect.

---

## 18. Delivery plan

### Phase 0: Shell proof

- Electron menu-bar lifecycle.
- Clickable menu-bar popover.
- Both global entry shortcuts.
- Focused summon with immediate Space/arrows.
- Escape dismissal and prior-app restoration.
- Always-on-top, click-through, Spaces, and multi-display spike.

Do not build the full parser until these macOS behaviors pass on a packaged build.

### Phase 1: Shared reading engine

- Markdown AST and source mapping.
- Headings, sentences, technical entities, and parenthetical spans.
- Unitization and timing.
- Recognition pivot.
- Shared context and progress models.
- Comprehensive fixtures and unit tests.

### Phase 2: Overlay product

- Shared ReadingStage.
- Compact, Docked Rail, Peek, and Expanded.
- Horizontal word and vertical sentence context.
- Header-delineated progress.
- Layout controls and persistence.
- Accessibility and visual regression tests.

### Phase 3: Library and capture

- SQLite and FTS5.
- Library, Browse, original source, and resume.
- Go `readerctl`.
- Claude Code and Codex setup, diagnostics, and repair.

### Phase 4: Packaging and polish

- Signed and notarized distribution.
- Login item and updates.
- Performance and memory tuning.
- Retention controls and editor integration.
- Manual macOS compatibility matrix.

---

## 19. Fixed product decisions

- Electron, React, and TypeScript replace Swift/SwiftUI for the MVP.
- The app is menu-bar-first and does not open Library on launch.
- The overlay is the primary product surface.
- Document Mode and Agent Response Mode have separate global shortcuts.
- An explicitly summoned session takes focus so bare reading keys work immediately.
- Escape dismisses the overlay.
- Passive mode uses chorded global controls and never captures bare Space/arrows.
- The recognition pivot is fixed on screen and highlighted by default.
- Prose defaults to one word per unit.
- Paths and coherent technical symbols remain intact and slow proportionally.
- Same-sentence word context is horizontal; adjacent-sentence context is vertical.
- Prose parentheses are modeled as spans; technical parentheses remain part of technical units.
- H1–H6 context appears in the upper-left and delineates progress.
- All layouts share the same reading state and ReadingStage implementation.
- Capture happens at completed-turn boundaries, not by scraping the TUI.
- Hooks enqueue locally and do no heavy work.
- Original content is always preserved.
- The overlay is not stealthy or hidden from capture.

## 20. Decisions remaining before release

1. Final product name, icon, and bundle identifier.
2. Final shortcut defaults after conflict testing.
3. Direct-download-only distribution versus a later Mac App Store variant.
4. Update mechanism and signing/notarization account.
5. Default persistent layout, opacity, dimensions, and context counts after usability testing.
6. Default technical slowdown and section-entry timings after calibration.
7. Whether code defaults to declaration-sized or lexical units.
8. Which editors receive first-party **Open in Editor** support.
9. Whether the app auto-starts at login after onboarding.
10. Whether “Agent Response Mode” or “Claude Response Mode” is the user-facing label.

---

## 21. Current implementation references

- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)
- [Electron Tray](https://www.electronjs.org/docs/latest/api/tray)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex hooks documentation](https://developers.openai.com/codex/hooks)

These integration references were last rechecked on 2026-08-06. Hook payload schemas and availability must be verified again against the installed Claude Code and Codex versions before shipping.
