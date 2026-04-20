/**
 * Client-side per-session metadata: user-chosen alias + last-accessed
 * timestamp. Both live in localStorage — they're UI affordances, not part
 * of the session's canonical record (which stays server-side).
 */

const ALIAS_KEY       = "botdock:session-aliases";
const LAST_ACCESS_KEY = "botdock:session-last-access";

type StringMap = Record<string, string>;
type NumberMap = Record<string, number>;

function loadMap<T extends StringMap | NumberMap>(key: string): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {} as T;
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as T) : ({} as T);
  } catch { return {} as T; }
}

function saveMap(key: string, map: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch {}
}

// -- aliases -----------------------------------------------------------------

export function getAliases(): StringMap {
  return loadMap<StringMap>(ALIAS_KEY);
}

export function getAlias(id: string): string | undefined {
  const s = getAliases()[id];
  return s && s.trim() ? s : undefined;
}

export function setAlias(id: string, alias: string): void {
  const map = getAliases();
  const trimmed = alias.trim();
  if (trimmed.length === 0) delete map[id];
  else map[id] = trimmed;
  saveMap(ALIAS_KEY, map);
}

// -- last access -------------------------------------------------------------

export function touchLastAccess(id: string): void {
  const map = loadMap<NumberMap>(LAST_ACCESS_KEY);
  map[id] = Date.now();
  saveMap(LAST_ACCESS_KEY, map);
}

export function getLastAccess(id: string): number {
  return loadMap<NumberMap>(LAST_ACCESS_KEY)[id] ?? 0;
}
