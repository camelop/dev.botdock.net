/**
 * Per-session in-memory cache of the transcript / raw / events streams we've
 * already received from the daemon. Survives session switches within a single
 * tab (reset on page reload — the daemon resends from byte 0 then).
 *
 * Problem it solves: SessionView previously re-fetched the full transcript
 * every time the user clicked into a session. For long Claude Code
 * conversations this is multi-MB of JSONL, plus parseTranscript cost, which
 * made "switch sessions" feel sluggish and blocked the UI thread. With the
 * cache, the WS upgrade URL carries the byte offsets the client already has,
 * the daemon only sends what's new, and the initial render on a re-visit is
 * near-instant.
 *
 * The cache is append-only on a per-session basis; we never mutate bytes
 * that already landed. If the daemon returns a shorter size than we cached
 * (shouldn't happen, but: session reset/reprovision), we fall back to a
 * full resync by clearing the entry.
 */

import type { SessionEventRecord } from "../api";

export type SessionStreamCache = {
  /** Bytes mirrored so far (wire-level UTF-8 length). */
  transcriptBytes: number;
  transcriptText: string;
  rawBytes: number;
  rawText: string;
  eventsOffset: number;
  events: SessionEventRecord[];
};

const cache = new Map<string, SessionStreamCache>();

export function getCache(id: string): SessionStreamCache | undefined {
  return cache.get(id);
}

export function seedCache(id: string): SessionStreamCache {
  let entry = cache.get(id);
  if (!entry) {
    entry = {
      transcriptBytes: 0, transcriptText: "",
      rawBytes: 0, rawText: "",
      eventsOffset: 0, events: [],
    };
    cache.set(id, entry);
  }
  return entry;
}

/** Append a transcript delta. Returns the updated cumulative text. */
export function appendTranscript(id: string, chunk: string): string {
  const entry = seedCache(id);
  entry.transcriptText += chunk;
  entry.transcriptBytes += utf8Bytes(chunk);
  return entry.transcriptText;
}

export function appendRaw(id: string, chunk: string): string {
  const entry = seedCache(id);
  entry.rawText += chunk;
  entry.rawBytes += utf8Bytes(chunk);
  return entry.rawText;
}

export function appendEvents(id: string, records: SessionEventRecord[], nextOffset: number): SessionEventRecord[] {
  const entry = seedCache(id);
  entry.events = entry.events.concat(records);
  entry.eventsOffset = nextOffset;
  return entry.events;
}

export function clearCache(id: string): void {
  cache.delete(id);
}

function utf8Bytes(s: string): number {
  // The server advances offsets by the byte length of the delta it read
  // from the file, so we must match that (JS string length would miss
  // multibyte chars). TextEncoder is the standard way.
  return new TextEncoder().encode(s).length;
}
