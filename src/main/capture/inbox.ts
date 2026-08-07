import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { CaptureEnvelope, CaptureSource } from '@shared/types';
import { envelopeToImport, type Store } from '../store/db';

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const VALID_SOURCES: CaptureSource[] = ['claude-code', 'codex'];

export interface ImportedCapture {
  documentId: number;
  duplicate: boolean;
  source: CaptureSource;
  title: string;
  repository: string | null;
}

/**
 * Validate an inbox payload before it is trusted.
 *
 * Captured text and metadata are untrusted input (SPEC 13): everything is
 * type-checked and bounded, and content is only ever stored, never executed.
 */
export function parseEnvelope(raw: string): CaptureEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  if (v.schema_version !== 1) return null;
  if (typeof v.source !== 'string' || !VALID_SOURCES.includes(v.source as CaptureSource)) return null;
  if (typeof v.content !== 'string' || v.content.length === 0) return null;
  if (Buffer.byteLength(v.content, 'utf8') > MAX_CONTENT_BYTES) return null;

  const str = (key: string): string | undefined =>
    typeof v[key] === 'string' && (v[key] as string).length > 0 ? (v[key] as string) : undefined;

  const envelope: CaptureEnvelope = {
    schema_version: 1,
    source: v.source as CaptureSource,
    content: v.content,
    captured_at:
      typeof v.captured_at === 'string' && !Number.isNaN(Date.parse(v.captured_at))
        ? v.captured_at
        : new Date().toISOString(),
  };
  const sourceVersion = str('source_version');
  if (sourceVersion) envelope.source_version = sourceVersion;
  const sessionId = str('session_id');
  if (sessionId) envelope.session_id = sessionId;
  const turnId = str('turn_id');
  if (turnId) envelope.turn_id = turnId;
  const cwd = str('cwd');
  if (cwd) envelope.cwd = cwd;
  const model = str('model');
  if (model) envelope.model = model;
  return envelope;
}

/**
 * Watches the atomic inbox written by `readerctl` and imports ready events
 * idempotently, whether they arrived while running or before launch (SPEC 10.5).
 */
export class InboxWatcher {
  private readonly readyDir: string;
  private readonly tmpDir: string;
  private readonly socketPath: string;
  private watcher: fs.FSWatcher | null = null;
  private server: net.Server | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private supportDir: string,
    private store: Store,
    private onImported: (capture: ImportedCapture) => void,
  ) {
    this.readyDir = path.join(supportDir, 'inbox', 'ready');
    this.tmpDir = path.join(supportDir, 'inbox', 'tmp');
    this.socketPath = path.join(supportDir, 'readerctl.sock');
  }

  start(): void {
    fs.mkdirSync(this.readyDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });

    try {
      this.watcher = fs.watch(this.readyDir, () => this.drain());
    } catch {
      // Fall through to polling if the watch cannot be established.
    }
    // A slow poll covers watcher gaps and network volumes.
    this.pollTimer = setInterval(() => this.drain(), 5000);
    this.startWakeSocket();
    this.drain();
  }

  /** Lightweight wake channel; `readerctl` connects and disconnects. */
  private startWakeSocket(): void {
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      /* ignore */
    }
    try {
      const server = net.createServer((socket) => {
        socket.on('data', () => this.drain());
        socket.on('error', () => socket.destroy());
        socket.setTimeout(1000, () => socket.destroy());
      });
      server.on('error', () => {
        /* wake is best effort */
      });
      server.listen(this.socketPath);
      this.server = server;
    } catch {
      /* wake is best effort */
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.server?.close();
    this.server = null;
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  /** Import every ready event. Safe to call concurrently; runs one at a time. */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      let files: string[];
      try {
        files = fs.readdirSync(this.readyDir).filter((f) => f.endsWith('.json')).sort();
      } catch {
        return;
      }
      for (const file of files) this.importOne(path.join(this.readyDir, file));
    } finally {
      this.draining = false;
    }
  }

  private importOne(file: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }

    const envelope = parseEnvelope(raw);
    if (!envelope) {
      // Never block the agent, and never keep a payload we cannot understand.
      this.quarantine(file);
      return;
    }

    try {
      const result = this.store.import(envelopeToImport(envelope));
      this.store.recordCapture(
        envelope,
        result.duplicate ? 'duplicate' : 'imported',
        result.documentId,
      );
      fs.rmSync(file, { force: true });
      if (!result.duplicate) {
        const summary = this.store.summary(result.documentId);
        this.onImported({
          documentId: result.documentId,
          duplicate: false,
          source: envelope.source,
          title: summary?.title ?? 'Captured response',
          repository: summary?.repository ?? null,
        });
      }
    } catch (error) {
      this.store.recordCapture(envelope, 'failed', null, redact(error));
      this.quarantine(file);
    }
  }

  /** Move an unusable payload aside so the queue cannot stall on it. */
  private quarantine(file: string): void {
    const failedDir = path.join(this.supportDir, 'inbox', 'failed');
    try {
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(file, path.join(failedDir, path.basename(file)));
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** Strip content, paths and identifiers out of an error before recording it. */
export function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\/[\w./-]+/g, '<path>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .slice(0, 300);
}
