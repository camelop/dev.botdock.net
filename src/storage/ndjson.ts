import { appendFileSync, openSync, readSync, closeSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Append one JSON-serializable record as a single line. Creates parent dir if needed. */
export function appendNdjson(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf8" });
}

export type NdjsonReadResult<T> = {
  records: T[];
  /** Byte offset at end of last complete line read — pass back as `fromOffset` to resume. */
  nextOffset: number;
};

/**
 * Read complete lines from an NDJSON file starting at `fromOffset`.
 * Partial trailing lines (no \n yet) are left for the next call.
 */
export function readNdjson<T = unknown>(path: string, fromOffset = 0): NdjsonReadResult<T> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { records: [], nextOffset: fromOffset };
  }
  if (fromOffset >= size) return { records: [], nextOffset: fromOffset };

  const fd = openSync(path, "r");
  try {
    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromOffset);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { records: [], nextOffset: fromOffset };
    const complete = text.slice(0, lastNl);
    const records: T[] = [];
    for (const line of complete.split("\n")) {
      if (line.length === 0) continue;
      records.push(JSON.parse(line) as T);
    }
    return { records, nextOffset: fromOffset + Buffer.byteLength(complete, "utf8") + 1 };
  } finally {
    closeSync(fd);
  }
}
