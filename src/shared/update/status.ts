/**
 * The update state the main process publishes to renderers.
 *
 * Every variant carries what the UI needs to render it without asking a follow
 * up question — notably `manual`, which always says *why* a small update was not
 * possible rather than silently offering a 121 MB download.
 */
export type UpdateStatusMessage =
  | { state: 'idle'; lastChecked?: string }
  | { state: 'checking' }
  | { state: 'up-to-date'; version: string; lastChecked: string }
  | { state: 'downloading'; version: string; received: number; total: number }
  | { state: 'ready'; version: string; notes: string; bytes: number }
  | { state: 'manual'; version: string; notes: string; url: string; explanation: string }
  | { state: 'error'; message: string };
