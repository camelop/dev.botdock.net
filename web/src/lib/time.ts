/**
 * Human-friendly relative time: "3s ago", "5m ago", "2h ago", or a local date
 * for anything older than ~2 days.
 */
export function relativeTime(ts: string | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 5)   return "just now";
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 24 * 3600) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2 * 24 * 3600) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(t).toLocaleString();
}

/** ISO string with the local date's wall-clock time for the hover tooltip. */
export function fullTime(ts: string | undefined): string {
  if (!ts) return "";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  return new Date(t).toLocaleString() + `  (${ts})`;
}
