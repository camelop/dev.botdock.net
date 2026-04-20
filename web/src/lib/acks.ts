/**
 * Per-session acknowledgment of the "pending, needs your input" state.
 *
 * Stored in localStorage keyed by session id. An ack is bound to the
 * `last_transcript_at` value at the moment of ack — if the session's
 * transcript grows after that timestamp (i.e. the agent posted another
 * turn), the ack is stale and the session re-surfaces in the todo list.
 *
 * This keeps the state client-side on purpose: acks are UI nudges, not
 * part of the session's canonical record.
 */

const KEY = "botdock:session-acks";

type AckMap = Record<string, { ack_at: string; ack_for_transcript_at: string | undefined }>;

function load(): AckMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as AckMap;
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}

function save(map: AckMap): void {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {}
}

export function isAcked(sessionId: string, lastTranscriptAt: string | undefined): boolean {
  const map = load();
  const entry = map[sessionId];
  if (!entry) return false;
  if (!lastTranscriptAt) return true;
  if (!entry.ack_for_transcript_at) return true;
  // Ack is valid only as long as the transcript hasn't grown since.
  return Date.parse(lastTranscriptAt) <= Date.parse(entry.ack_for_transcript_at);
}

export function ackSession(sessionId: string, lastTranscriptAt: string | undefined): void {
  const map = load();
  map[sessionId] = {
    ack_at: new Date().toISOString(),
    ack_for_transcript_at: lastTranscriptAt,
  };
  save(map);
}

export function unackSession(sessionId: string): void {
  const map = load();
  delete map[sessionId];
  save(map);
}
