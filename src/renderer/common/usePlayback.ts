import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CONTEXT,
  buildStageSnapshot,
  type ContextSettings,
  type StageSnapshot,
} from '@shared/context';
import { needsRefill, windowView, type ReadingWindow } from '@shared/window';
import type { PlaybackStatus } from '@shared/types';
import type { SessionStateMessage } from '@shared/ipc';
import { api } from './api';

export interface Playback {
  snapshot: StageSnapshot | null;
  status: PlaybackStatus;
  index: number;
  unitCount: number;
  hasDocument: boolean;
  toggle(): void;
  step(delta: number): void;
  stepHeading(direction: -1 | 1): void;
  restartSection(): void;
  seek(index: number): void;
  adjustWpm(delta: number): void;
}

/**
 * Drives the RSVP clock in the renderer.
 *
 * The main process owns the document and the authoritative position, but the
 * frame-accurate dwell loop lives here: scheduling against `requestAnimationFrame`
 * keeps transition jitter inside one frame (SPEC 14) instead of paying an IPC
 * round trip per word.
 */
export function usePlayback(context: ContextSettings = DEFAULT_CONTEXT): Playback {
  const [win, setWin] = useState<ReadingWindow | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<PlaybackStatus>('paused');
  const [snapshot, setSnapshot] = useState<StageSnapshot | null>(null);

  const winRef = useRef<ReadingWindow | null>(null);
  const indexRef = useRef(0);
  const statusRef = useRef<PlaybackStatus>('paused');
  const revisionRef = useRef(-1);
  const dueAtRef = useRef(0);
  const frameRef = useRef(0);
  const refillingRef = useRef(false);

  winRef.current = win;
  indexRef.current = index;
  statusRef.current = status;

  const refill = useCallback(async (center: number) => {
    if (refillingRef.current) return;
    refillingRef.current = true;
    try {
      const next = await api.getWindow(center);
      if (next) setWin(next);
    } finally {
      refillingRef.current = false;
    }
  }, []);

  // Recompute the stage whenever the position or the window changes. Both a
  // full document and a bounded window satisfy the same view interface, so the
  // context, pivot and progress logic here is the one shared implementation.
  useEffect(() => {
    if (!win) {
      setSnapshot(null);
      return;
    }
    setSnapshot(buildStageSnapshot(windowView(win), win.documentId, index, context));
    if (needsRefill(win, index)) void refill(index);
  }, [win, index, context, refill]);

  // Adopt state pushed by the main process. Only an explicit seek (a new
  // revision) moves our position; ordinary echoes of our own progress do not.
  useEffect(() => {
    const applyState = (state: SessionStateMessage) => {
      setStatus(state.status);
      if (state.revision !== revisionRef.current) {
        revisionRef.current = state.revision;
        setIndex(state.unitIndex);
        dueAtRef.current = 0;
      }
    };

    const offState = api.on('session:state', (payload) => applyState(payload as SessionStateMessage));
    const offWindow = api.on('session:window', (payload) => {
      const next = payload as ReadingWindow;
      setWin(next);
    });

    void (async () => {
      const [state, initial] = await Promise.all([api.getSessionState(), api.getWindow()]);
      if (initial) setWin(initial);
      applyState(state);
    })();

    return () => {
      offState();
      offWindow();
    };
  }, []);

  // The dwell loop. Each unit is shown for its own scheduled duration, and the
  // deadline is carried forward so a slow frame does not accumulate drift.
  useEffect(() => {
    const tick = () => {
      frameRef.current = requestAnimationFrame(tick);
      if (statusRef.current !== 'playing') {
        dueAtRef.current = 0;
        return;
      }
      const current = winRef.current;
      if (!current) return;

      const i = indexRef.current;
      const unit = current.units[i - current.start];
      if (!unit) return;

      const now = performance.now();
      if (dueAtRef.current === 0) {
        dueAtRef.current = now + unit.dwellMs;
        return;
      }
      if (now < dueAtRef.current) return;

      const next = i + 1;
      if (next >= current.unitCount) {
        statusRef.current = 'paused';
        setStatus('paused');
        dueAtRef.current = 0;
        void api.sendCommand({ type: 'advance', value: i, status: 'paused' });
        return;
      }
      // Carry the deadline forward rather than restarting from `now`.
      dueAtRef.current += unit.dwellMs;
      if (dueAtRef.current < now) dueAtRef.current = now;
      indexRef.current = next;
      setIndex(next);
      void api.sendCommand({ type: 'advance', value: next, status: 'playing' });
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  const send = useCallback((command: Parameters<typeof api.sendCommand>[0]) => {
    void api.sendCommand(command);
  }, []);

  return {
    snapshot,
    status,
    index,
    unitCount: win?.unitCount ?? 0,
    hasDocument: win !== null,
    toggle: () => send({ type: 'toggle' }),
    step: (delta: number) => send({ type: 'step', value: delta }),
    stepHeading: (direction: -1 | 1) => send({ type: 'heading', value: direction }),
    restartSection: () => send({ type: 'restartSection' }),
    seek: (target: number) => send({ type: 'seek', value: target }),
    adjustWpm: (delta: number) => send({ type: 'wpm', value: delta }),
  };
}
