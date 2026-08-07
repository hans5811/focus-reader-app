import type { FocusReaderApi } from '@shared/ipc';

declare global {
  interface Window {
    focusReader: FocusReaderApi;
  }
}

/** The preload bridge. Nothing else crosses the sandbox boundary. */
export const api: FocusReaderApi = window.focusReader;
