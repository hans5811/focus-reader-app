import { globalShortcut } from 'electron';
import type { ShortcutStatus } from '@shared/ipc';
import { SHORTCUT_LABELS, type Preferences, type PreferencesService, type ShortcutAction } from './prefs';

export type ShortcutHandlers = Record<ShortcutAction, () => void>;

const MODIFIERS = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];

/**
 * A global accelerator must be chorded.
 *
 * Registering bare Space or an arrow key system-wide would break editors,
 * terminals, browsers and media controls, so it is rejected outright
 * (SPEC 4.3, 19).
 */
export function isValidGlobalAccelerator(accelerator: string): { ok: boolean; reason?: string } {
  const trimmed = accelerator.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'Shortcut is empty.' };
  const parts = trimmed.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    return { ok: false, reason: 'Global shortcuts must include at least one modifier key.' };
  }
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (!modifiers.every((m) => MODIFIERS.includes(m))) {
    return { ok: false, reason: `Unrecognized modifier in "${trimmed}".` };
  }
  if (MODIFIERS.includes(key)) {
    return { ok: false, reason: 'Shortcut needs a non-modifier key.' };
  }
  return { ok: true };
}

export class ShortcutService {
  private statuses = new Map<ShortcutAction, ShortcutStatus>();
  private handlers: ShortcutHandlers | null = null;

  constructor(private prefs: PreferencesService) {}

  /** (Re)register every configured shortcut, recording per-action failures. */
  registerAll(handlers: ShortcutHandlers): ShortcutStatus[] {
    this.handlers = handlers;
    globalShortcut.unregisterAll();
    this.statuses.clear();

    const shortcuts = this.prefs.all().shortcuts;
    for (const action of Object.keys(shortcuts) as ShortcutAction[]) {
      this.registerOne(action, shortcuts[action]);
    }
    return this.status();
  }

  private registerOne(action: ShortcutAction, accelerator: string): ShortcutStatus {
    const label = SHORTCUT_LABELS[action];
    const validity = isValidGlobalAccelerator(accelerator);
    let registered = false;
    let error: string | null = validity.ok ? null : (validity.reason ?? 'Invalid shortcut.');

    if (validity.ok && this.handlers) {
      try {
        registered = globalShortcut.register(accelerator, this.handlers[action]);
        if (!registered) {
          error = `${accelerator} is already claimed by another application.`;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Registration failed.';
      }
    }

    const status: ShortcutStatus = { action, label, accelerator, registered, error };
    this.statuses.set(action, status);
    return status;
  }

  status(): ShortcutStatus[] {
    return (Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map(
      (action) =>
        this.statuses.get(action) ?? {
          action,
          label: SHORTCUT_LABELS[action],
          accelerator: this.prefs.all().shortcuts[action],
          registered: false,
          error: 'Not registered.',
        },
    );
  }

  /**
   * Rebind one action. On failure the previous working shortcut is restored,
   * so a conflict never leaves the user without a way in (SPEC 15).
   */
  rebind(action: ShortcutAction, accelerator: string): ShortcutStatus[] {
    const previous = this.prefs.all().shortcuts[action];
    if (previous === accelerator) return this.status();

    const validity = isValidGlobalAccelerator(accelerator);
    if (!validity.ok) {
      this.statuses.set(action, {
        action,
        label: SHORTCUT_LABELS[action],
        accelerator: previous,
        registered: this.statuses.get(action)?.registered ?? false,
        error: validity.reason ?? 'Invalid shortcut.',
      });
      return this.status();
    }

    try {
      globalShortcut.unregister(previous);
    } catch {
      /* it may not have been registered */
    }

    const result = this.registerOne(action, accelerator);
    if (result.registered) {
      const shortcuts: Preferences['shortcuts'] = { ...this.prefs.all().shortcuts, [action]: accelerator };
      this.prefs.update({ shortcuts });
      return this.status();
    }

    // Restore the previous binding and report the conflict against it.
    const restored = this.registerOne(action, previous);
    this.statuses.set(action, { ...restored, error: result.error });
    return this.status();
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
    this.statuses.clear();
  }
}
