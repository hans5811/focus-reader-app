# Focus Reader

A local-first, menu-bar-first macOS app for reading long technical documents and
completed coding-agent responses with RSVP (rapid serial visual presentation).

Implements [`docs/SPEC.md`](docs/SPEC.md) v2.0.

The primary surface is a floating overlay, not a window. One word at a time
crosses a pivot fixed at a stable screen coordinate, while technical units —
`station_record_id`, `Decimal(9, 3)`, `services/ingest/models/station_registry.py` —
stay intact and get proportionally more time.

---

## Getting started

```bash
npm install
npm run build:helper   # builds the Go capture helper into ./bin/readerctl
npm start              # run in development
npm run package        # build Focus Reader.app into ./out
```

Requires Node 20+, Go 1.21+, and macOS.

| Script | What it does |
|---|---|
| `npm start` | Electron Forge dev mode with HMR for both renderers |
| `npm run package` | Builds `.app` (the `generateAssets` hook rebuilds `readerctl` and the icon) |
| `npm run make` | Produces a distributable ZIP |
| `npm run build:icon` | Regenerates `assets/icon.icns` |
| `npm test` | Vitest — engine, storage, capture, session state machine |
| `npm run test:helper` | Go tests for `readerctl` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src` and `test` |

On first launch there is **no window and no Dock icon** — look for the menu-bar
icon. Press <kbd>⌃⌥D</kbd> to read the clipboard.

The keyboard guide opens automatically the first time you summon the reader, and
is available afterwards from <kbd>?</kbd> in the overlay, the `?` button in either
window, the overlay context menu, or **Keyboard Shortcuts…** in the menu bar. It
renders the bindings actually in effect, so it stays correct after a rebind and
flags any shortcut another app has claimed.

---

## Architecture

```
Claude Code / Codex
        │  Stop hook
        ▼
Go readerctl ──► atomic inbox (tmp → rename → ready)
                      │
                      ▼
              Electron main process
                ├── SQLite + FTS5, imports, search
                ├── menu bar, global shortcuts
                ├── window policy (always-on-top, click-through, Spaces)
                └── ReadingSession — authoritative document + position
                      │  bounded window over IPC
                      ▼
              sandboxed React renderers (overlay, library)
                      │
                      ▼
              shared TypeScript reading engine
```

### Where things live

| Path | Role |
|---|---|
| `src/shared/` | Framework-independent engine: parsing, unitization, timing, pivot, context, progress. No Electron, no React. |
| `src/main/` | App lifecycle, tray, shortcuts, window policy, storage, capture, IPC. |
| `src/preload/` | The only bridge across the sandbox: fixed channel names, no dynamic access. |
| `src/renderer/overlay/` | `ReadingStage` + the four layouts. |
| `src/renderer/library/` | Library, Browse, Capture & Setup, Preferences. |
| `readerctl/` | Go hook helper. |
| `test/` | Vitest suites and the checked-in fixture corpus. |

### Three design decisions worth knowing

**The pivot is fixed by layout; only the font size is measured.** The word row is
a three-column grid, `minmax(0, 1fr) auto minmax(0, 1fr)`, whose middle column
holds exactly the pivot grapheme. Equal fractional side columns put that column
at the same screen coordinate regardless of word or context length, and turning
off the pivot highlight changes colour only — alignment is structural.

The explicit zero minimums are load-bearing. A bare `1fr` is `minmax(auto, 1fr)`,
and that auto minimum forbids a column from shrinking below its content: the row
then either overruns the window or crushes the focused word into a
one-character-wide column and stacks it vertically. Nothing inside a lane may
flex-shrink either — surplus *context* is clipped off the far edge instead, so
the focused unit is never touched. The font size is fitted by measuring the real
glyph run against the live row width, against the *longer* half, since a centred
pivot gives each side only half the row.

**List markers are synthesised, not scavenged.** Markdown consumes `1.`, `-`
and `[x]`, so an item's text begins after them — which would silently drop
ordered numbering and make `- [x]` read identically to `- [ ]`. The parser reads
each marker back out of the source and emits it as its own reading unit (`1.`,
`•`, `☐`, `☑`) with a real source range, and tags every unit in the item with its
nesting depth. Markers belong to no sentence, so they never pollute the
same-sentence word context.

**Prism highlights; a separate deterministic lexer unitizes.** The highlighter
supplies token ranges and the regions that must stay atomic (strings, comments);
a language-independent bracket-depth lexer decides where reading units begin and
end. An unsupported language therefore degrades to sane lexical units instead of
shattering into punctuation.

**The main process owns position; the renderer owns the clock.** Main is
authoritative for the document, index, and play/pause status so global shortcuts
and every layout act on one state. The frame-accurate dwell loop runs in the
renderer against `requestAnimationFrame`, carrying its deadline forward so a slow
frame does not accumulate drift — that keeps transition jitter inside one frame
instead of paying an IPC round trip per word. Only an explicit seek (a new
`revision`) moves the renderer's position; echoes of its own progress do not.

### Storage

SQLite via Node's built-in `node:sqlite` (Electron 43 ships Node 24, which has it
with FTS5) — so there is no native module to rebuild. Search uses an
external-content FTS5 index kept in step by triggers, so document text is stored
once and the update trigger is scoped to the indexed columns, leaving
position-saving writes untouched.

The renderer never holds a whole document. It receives a bounded window around
the active position and refills as it nears an edge. A full `ParsedDocument` and
a window both satisfy the same `DocumentView` interface, so context, pivot, and
progress logic exists exactly once.

Schema changes are applied additively at open (`CREATE TABLE IF NOT EXISTS`
leaves an existing database on the old shape), and documents imported by an
older engine are reparsed at launch when their stored parser version no longer
matches. Only derived tables are rebuilt — the original source is never
rewritten — and reading positions survive by unit index.

---

## Sharing a build

```bash
npm run make   # → out/make/zip/darwin/arm64/Focus Reader-darwin-arm64-1.0.0.zip  (~129 MB)
```

The ZIP contains `Focus Reader.app`, arm64 only. What happens when someone else
opens it depends entirely on how it was signed, and there are three tiers.

### As built today: ad-hoc, no Apple account

The bundle carries a valid ad-hoc signature — `codesign --verify --deep
--strict` passes and the identifier is `com.focusreader.app` — but ad-hoc means
*no identity*, so Gatekeeper still refuses a copy that arrives with a quarantine
flag (download, AirDrop, email, Slack). Verified by re-quarantining an unzipped
build: signature intact, `spctl` rejects.

The recipient sees “Apple could not verify … free of malware”, and on macOS 15
and later the old right-click → **Open** bypass no longer works. They must:

> **System Settings → Privacy & Security**, scroll to Security, **Open Anyway**
> next to Focus Reader, then confirm.

Or, in one line:

```bash
xattr -dr com.apple.quarantine "/Applications/Focus Reader.app"
```

Anyone who clones the repo and runs `npm run make` themselves gets no quarantine
flag at all, so for developer recipients handing over the repo is the least
friction.

### With a Developer ID ($99/yr Apple Developer Program)

The Forge config is already wired for it — nothing to edit, only environment to
supply:

```bash
export FR_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"   # not your Apple ID password
export APPLE_TEAM_ID="TEAMID"
npm run make
```

`FR_SIGN_IDENTITY` alone signs with the hardened runtime and
`assets/entitlements.plist`; adding the three `APPLE_*` variables also notarizes
and staples. The result opens on a first double-click with no warning. Signing
also replaces the ad-hoc re-sign step described below, and this app is **not**
App-Sandboxed — Developer ID does not require it, and the sandbox would break
both the inbox watcher and the global shortcuts.

**This path is untested.** No signing identity exists on this machine, so the
config is written from the documented contract, not from a build that ran.

### Beyond that

GitHub Releases or a Homebrew cask are just delivery for the notarized artifact
and need the tier above to be pleasant. There is no auto-update (SPEC 20 leaves
it open), so every update is a manual re-download.

### Why re-signing is needed at all

The fuses plugin ad-hoc signs during `packageAfterCopy`, but Packager rewrites
`Info.plist` afterwards to rename the bundle and apply `extendInfo`. That
invalidated the signature it had just made: builds claimed `com.github.Electron`
with an unbound plist, and `spctl` reported *“invalid Info.plist (plist or
signature have been modified)”* — which macOS surfaces to a user as **damaged**,
a dead end that no Open Anyway gets past. A `postPackage` hook in
`forge.config.ts` therefore signs once more, last, when no real identity is
configured.

---

## The icon

`assets/icon.icns` is generated by `scripts/make-icon.mjs` and not checked in —
the same reasoning as the menu-bar glyph in `src/main/tray.ts`. The mark *is* the
product idea, two context bars flanking a fixed pivot, so keeping it as source
means a change to it appears in a diff and the two marks cannot drift apart. The
script needs only Node's `zlib` and macOS's `iconutil`; it draws each slot
natively at 4× supersampling instead of downsampling from 1024, because 16pt and
32pt are where a rescaled pivot goes muddy.

The 16pt slot drops the bars and states the pivot alone. At that size the body is
under 13px across, the bars land near one pixel tall, and antialiasing smears
them into the pivot until the mark reads as an orange dot on an unbroken grey
band — so the small variant is simplified rather than shrunk.

---

## Capture

`readerctl` reads one hook event on stdin, normalizes it to the SPEC 10.2
envelope, writes a temp file, fsyncs, atomically renames it into `ready/`, pings
a Unix socket to wake a running app, and exits. It never parses Markdown, never
calls a model, never executes captured content, and **always exits 0** on
recoverable problems so it cannot block the coding agent.

Install the hooks from **Capture & Setup**, which shows the exact file, a
before/after preview, and a manual snippet before writing anything. Existing
settings are backed up and unrelated configuration is preserved — Claude Code's
JSON is merged, and Codex's TOML is appended to rather than rewritten.

### Verify the hook payload before shipping

`readerctl` prefers documented direct fields (`last_assistant_message`,
`last_agent_message`, and the content-block array shape) and falls back to
reading the last assistant message from `transcript_path` only when no direct
field is present. Per SPEC 21, **re-verify both hook schemas against the
installed Claude Code and Codex versions before release** and trim the field
lists in `contentKeys` to whatever those versions actually document.

---

## What is verified

- 100 Vitest tests and 8 Go tests pass; `tsc --noEmit` and ESLint are clean.
- Packaged `.app` builds and launches as a menu-bar-only accessory app.
- End-to-end on a packaged build: `readerctl` → inbox → import → SQLite, with
  `services/ingest/models/station_registry.py` at 570 ms (SPEC 8.5 targets
  500–800 ms at 300 WPM), `station_record_id`, `Decimal(9, 3)`, and
  `SensorReading(BaseModel):` all intact.
- Overlay rendering confirmed by screenshot against a live desktop: always-on-top
  over another app, H1/H2 ancestor chain upper-left, bare arrow keys working with
  no prior click, fixed pivot across changing word and context lengths,
  `(inferred from the payload)` treated as one prose aside across four units with a
  quiet secondary lane, and long paths wrapping at separators rather than
  truncating.
- FTS5 search with snippets and capture-event diagnostics.

## What is not done

These need a real desktop session, hardware, or credentials, and are called out
rather than assumed:

- **Manual macOS matrix** (SPEC 17): multiple Spaces, full-screen apps, monitor
  disconnect/reconnect, Terminal/iTerm/VS Code/Xcode interaction, and real
  VoiceOver. The code paths exist; they have not been exercised on that matrix.
- **Signing and notarization** (SPEC 18, Phase 4): the config path exists and is
  driven by `FR_SIGN_IDENTITY` / `APPLE_*`, but no certificate exists here, so it
  has never been executed. Builds are ad-hoc signed and Gatekeeper rejects them
  on another machine — see [Sharing a build](#sharing-a-build).
- **Login item and auto-update** (SPEC 18, Phase 4) — SPEC 20 leaves both open.
- **Visual regression snapshots** (SPEC 17): pivot-coordinate assertions are
  covered structurally by the grid and by manual screenshot verification, not by
  an automated image-diff suite.
- **A >1 MB fixture** (SPEC 17): the corpus covers every listed content category,
  but the large-document case is exercised by a generated 100k-word document in
  the performance test rather than a checked-in file.

## Open product decisions

SPEC 20 leaves ten decisions open. Two were forced by implementation and are
recorded here as defaults, not conclusions:

- **Code unit size** defaults to `lexical`, because it reproduces the spec's own
  example unit `SensorReading(BaseModel):` verbatim. Switchable in Preferences.
- **Default layout** is Compact at 96% opacity, pinned.
