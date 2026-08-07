import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CaptureSource } from '@shared/types';

export type HookSource = Extract<CaptureSource, 'claude-code' | 'codex'>;

export interface HookPlan {
  source: HookSource;
  /** Absolute path of the configuration file that would be edited. */
  file: string;
  fileExists: boolean;
  /** True when Focus Reader's hook is already installed. */
  installed: boolean;
  /** The exact text that would be written, for review before applying. */
  proposed: string;
  /** Current file contents, for a side-by-side preview. */
  current: string;
  /** Snippet the user can paste manually instead of letting us edit. */
  manualSnippet: string;
  backupPath: string;
}

export interface HookStatus {
  source: HookSource;
  file: string;
  installed: boolean;
  fileExists: boolean;
  /** Populated when the file exists but could not be understood. */
  problem: string | null;
}

/**
 * Recognizes our own hook command. The helper path is quoted (the bundle name
 * contains a space), so the binary name and the arguments are matched
 * separately rather than as one contiguous string.
 */
function isOurCommand(text: string): boolean {
  return text.includes('readerctl') && text.includes('ingest --source');
}

export function claudeSettingsPath(home = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

export function codexConfigPath(home = os.homedir()): string {
  return path.join(home, '.codex', 'config.toml');
}

export function configPathFor(source: HookSource, home = os.homedir()): string {
  return source === 'claude-code' ? claudeSettingsPath(home) : codexConfigPath(home);
}

export function hookCommand(binaryPath: string, source: HookSource): string {
  // The path is quoted because the app bundle contains a space, and captured
  // content is never interpolated into this string (SPEC 11.3).
  return `"${binaryPath}" ingest --source ${source}`;
}

/**
 * Merge Focus Reader's Stop hook into an existing Claude Code settings object.
 *
 * Unrelated settings and unrelated hooks are preserved exactly; the function is
 * pure so the merge can be unit tested without touching the filesystem.
 */
export function mergeClaudeSettings(
  existing: unknown,
  command: string,
): { settings: Record<string, unknown>; changed: boolean } {
  const settings: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const hooks: Record<string, unknown> =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? { ...(settings.hooks as Record<string, unknown>) }
      : {};

  const stop: unknown[] = Array.isArray(hooks.Stop) ? [...(hooks.Stop as unknown[])] : [];

  const alreadyInstalled = stop.some((matcher) => {
    if (!matcher || typeof matcher !== 'object') return false;
    const inner = (matcher as { hooks?: unknown }).hooks;
    if (!Array.isArray(inner)) return false;
    return inner.some(
      (h) =>
        h &&
        typeof h === 'object' &&
        typeof (h as { command?: unknown }).command === 'string' &&
        isOurCommand((h as { command: string }).command),
    );
  });

  if (alreadyInstalled) return { settings, changed: false };

  stop.push({ hooks: [{ type: 'command', command }] });
  hooks.Stop = stop;
  settings.hooks = hooks;
  return { settings, changed: true };
}

/**
 * Produce the Codex hook block.
 *
 * Codex configuration is TOML. Rather than parse and rewrite the user's file —
 * which would risk reformatting or dropping comments — the block is appended,
 * so unrelated configuration is preserved byte-for-byte.
 */
export function codexHookBlock(command: string): string {
  return [
    '',
    '# Added by Focus Reader. Enqueues the completed turn for reading.',
    '# Remove this block to uninstall.',
    '[[hooks.stop]]',
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    '',
  ].join('\n');
}

function readFileSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function backupPathFor(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.focus-reader-backup-${stamp}`;
}

/** Describe what installation would do, without changing anything (SPEC 9.3). */
export function planInstall(source: HookSource, binaryPath: string, home = os.homedir()): HookPlan {
  const file = configPathFor(source, home);
  const current = readFileSafe(file);
  const command = hookCommand(binaryPath, source);

  if (source === 'claude-code') {
    let parsed: unknown = null;
    if (current !== null && current.trim().length > 0) {
      try {
        parsed = JSON.parse(current);
      } catch {
        parsed = undefined; // signals unparseable
      }
    }
    const unparseable = parsed === undefined;
    const { settings, changed } = mergeClaudeSettings(unparseable ? {} : parsed, command);
    return {
      source,
      file,
      fileExists: current !== null,
      installed: !changed && !unparseable,
      proposed: unparseable ? (current ?? '') : `${JSON.stringify(settings, null, 2)}\n`,
      current: current ?? '',
      manualSnippet: JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } },
        null,
        2,
      ),
      backupPath: backupPathFor(file),
    };
  }

  const block = codexHookBlock(command);
  const installed = current !== null && isOurCommand(current);
  return {
    source,
    file,
    fileExists: current !== null,
    installed,
    proposed: installed ? (current ?? '') : `${current ?? ''}${block}`,
    current: current ?? '',
    manualSnippet: block.trim(),
    backupPath: backupPathFor(file),
  };
}

export interface InstallOutcome {
  ok: boolean;
  changed: boolean;
  backupPath: string | null;
  /** Set when the file exists but cannot be merged safely (SPEC 15). */
  conflict: string | null;
}

/**
 * Apply the plan, after backing up the existing file.
 *
 * A configuration file we cannot parse is never overwritten; the caller shows
 * the manual snippet instead (SPEC 15, configuration conflict).
 */
export function installHook(
  source: HookSource,
  binaryPath: string,
  home = os.homedir(),
): InstallOutcome {
  const file = configPathFor(source, home);
  const current = readFileSafe(file);
  const command = hookCommand(binaryPath, source);

  if (source === 'claude-code' && current !== null && current.trim().length > 0) {
    try {
      JSON.parse(current);
    } catch {
      return {
        ok: false,
        changed: false,
        backupPath: null,
        conflict: `${file} is not valid JSON. Focus Reader will not overwrite it; add the hook manually.`,
      };
    }
  }

  const plan = planInstall(source, binaryPath, home);
  if (plan.installed) return { ok: true, changed: false, backupPath: null, conflict: null };

  let backupPath: string | null = null;
  if (current !== null) {
    backupPath = plan.backupPath;
    fs.writeFileSync(backupPath, current, { mode: 0o600 });
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (source === 'claude-code') {
    fs.writeFileSync(file, plan.proposed, { mode: 0o600 });
  } else {
    fs.appendFileSync(file, codexHookBlock(command), { mode: 0o600 });
  }
  return { ok: true, changed: true, backupPath, conflict: null };
}

/** Remove Focus Reader's hook, leaving every other setting untouched. */
export function removeHook(source: HookSource, home = os.homedir()): InstallOutcome {
  const file = configPathFor(source, home);
  const current = readFileSafe(file);
  if (current === null) return { ok: true, changed: false, backupPath: null, conflict: null };

  const backupPath = backupPathFor(file);
  fs.writeFileSync(backupPath, current, { mode: 0o600 });

  if (source === 'claude-code') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(current) as Record<string, unknown>;
    } catch {
      return { ok: false, changed: false, backupPath, conflict: `${file} is not valid JSON.` };
    }
    const hooks = parsed.hooks as Record<string, unknown> | undefined;
    const stop = hooks && Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : null;
    if (!stop) return { ok: true, changed: false, backupPath, conflict: null };

    const kept = stop.filter((matcher) => {
      const inner = (matcher as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) return true;
      return !inner.some(
        (h) => typeof (h as { command?: unknown })?.command === 'string' &&
          isOurCommand((h as { command: string }).command),
      );
    });
    if (kept.length === stop.length) return { ok: true, changed: false, backupPath, conflict: null };

    if (kept.length > 0) hooks!.Stop = kept;
    else delete hooks!.Stop;
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, changed: true, backupPath, conflict: null };
  }

  // Drop the appended block, matching the comment header we wrote. The command
  // line is matched loosely because the quoted helper path contains escapes.
  const cleaned = current.replace(
    /\n?# Added by Focus Reader\.[\s\S]*?command = .*readerctl.*\n/g,
    '\n',
  );
  if (cleaned === current) return { ok: true, changed: false, backupPath, conflict: null };
  fs.writeFileSync(file, cleaned, { mode: 0o600 });
  return { ok: true, changed: true, backupPath, conflict: null };
}

export function hookStatus(source: HookSource, home = os.homedir()): HookStatus {
  const file = configPathFor(source, home);
  const current = readFileSafe(file);
  if (current === null) {
    return { source, file, installed: false, fileExists: false, problem: null };
  }
  if (source === 'claude-code' && current.trim().length > 0) {
    try {
      JSON.parse(current);
    } catch {
      return { source, file, installed: false, fileExists: true, problem: 'not valid JSON' };
    }
  }
  return {
    source,
    file,
    installed: isOurCommand(current),
    fileExists: true,
    problem: null,
  };
}
