import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  api,
  MARKDOWN_CONTENT_LIMIT,
  type MarkdownMeta,
} from "../api";
import { relativeTime, fullTime } from "../lib/time";

// Lazy load the Monaco wrapper so the ~3 MB editor chunk only ships when
// the user actually opens the Markdown page. Everyone else pays zero.
const MarkdownMonacoEditor = lazy(() =>
  import("../components/MarkdownMonacoEditor").then((m) => ({ default: m.MarkdownMonacoEditor })),
);

// Draft mode: an in-memory-only record whose name hasn't yet passed the
// safe-name regex (or whose first POST is pending). Once name is valid
// and the autosave's POST returns successfully, we flip to edit mode and
// subsequent saves go through PUT.
type Draft = {
  kind: "draft";
  name: string;
  tagsText: string;
  content: string;
};
type Edit = {
  kind: "edit";
  name: string;          // immutable once saved
  tagsText: string;
  content: string;
  lastSavedMeta: MarkdownMeta;
};
type Selection = Draft | Edit | null;

// Autosave debounce — matches Notes' 600ms. Short enough that the user
// sees "saved" feedback almost immediately, long enough to coalesce
// typing bursts into a single write.
const AUTOSAVE_DEBOUNCE_MS = 600;

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function MarkdownsPage() {
  const [list, setList] = useState<MarkdownMeta[]>([]);
  const [listErr, setListErr] = useState("");
  const [selected, setSelected] = useState<Selection>(null);

  // Autosave plumbing. `saveState` drives the footer indicator; `err`
  // is the most recent save failure if any.
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string>("");
  const saveTimer = useRef<number | null>(null);
  // Monotonic counter so an in-flight save whose result lands AFTER the
  // user has moved on (switched records, typed more) can be ignored.
  const saveSeq = useRef(0);

  const refreshList = async () => {
    try {
      const ms = await api.listMarkdowns();
      setList(ms);
      setListErr("");
    } catch (e) {
      setListErr(String((e as Error).message ?? e));
    }
  };
  useEffect(() => { refreshList(); }, []);

  const cancelPendingSave = () => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    saveSeq.current += 1;  // in-flight saves should treat themselves as stale
  };

  const openMarkdown = async (name: string) => {
    cancelPendingSave();
    try {
      const r = await api.getMarkdown(name);
      setSelected({
        kind: "edit",
        name: r.meta.name,
        tagsText: (r.meta.tags ?? []).join(", "),
        content: r.content,
        lastSavedMeta: r.meta,
      });
      setSaveState("idle");
      setSaveErr("");
    } catch (e) {
      setSaveErr(String((e as Error).message ?? e));
    }
  };

  const startDraft = () => {
    cancelPendingSave();
    setSelected({
      kind: "draft",
      name: "",
      tagsText: "",
      content: "",
    });
    setSaveState("idle");
    setSaveErr("");
  };

  const deleteMarkdown = async (name: string) => {
    if (!confirm(`Delete markdown "${name}"? This cannot be undone.`)) return;
    cancelPendingSave();
    try {
      await api.deleteMarkdown(name);
      if (selected?.kind === "edit" && selected.name === name) {
        setSelected(null);
      }
      await refreshList();
    } catch (e) {
      setSaveErr(String((e as Error).message ?? e));
    }
  };

  /**
   * Queue an autosave for the given selection. Dispatches POST (draft →
   * first save) or PUT (edit → subsequent saves) depending on kind.
   * Cancels any pending save first. Skipped if a draft's name hasn't
   * yet passed the safe-name regex — we don't POST until it's valid.
   */
  const queueAutosave = (next: Draft | Edit) => {
    cancelPendingSave();
    if (next.kind === "draft") {
      if (!next.name || !NAME_PATTERN.test(next.name)) {
        // Can't save yet — leave state as "dirty" so the user sees the
        // pending indicator. A later name edit will re-schedule.
        setSaveState("dirty");
        return;
      }
    }
    setSaveState("dirty");
    const seq = ++saveSeq.current;
    saveTimer.current = window.setTimeout(async () => {
      saveTimer.current = null;
      setSaveState("saving");
      try {
        const tags = parseTags(next.tagsText);
        if (next.kind === "draft") {
          const meta = await api.createMarkdown({
            name: next.name,
            tags,
            content: next.content,
          });
          if (seq !== saveSeq.current) return;  // superseded mid-flight
          setList((cur) => [...cur.filter((m) => m.name !== meta.name), meta]
            .sort((a, b) => a.name.localeCompare(b.name)));
          setSelected({
            kind: "edit",
            name: meta.name,
            tagsText: next.tagsText,
            content: next.content,
            lastSavedMeta: meta,
          });
        } else {
          const meta = await api.updateMarkdown(next.name, {
            tags,
            content: next.content,
          });
          if (seq !== saveSeq.current) return;
          setList((cur) => cur.map((m) => (m.name === meta.name ? meta : m)));
          setSelected((cur) => {
            if (!cur || cur.kind !== "edit" || cur.name !== next.name) return cur;
            return { ...cur, lastSavedMeta: meta };
          });
        }
        setSaveState("saved");
        setSaveErr("");
      } catch (e) {
        if (seq !== saveSeq.current) return;
        setSaveState("error");
        setSaveErr(String((e as Error).message ?? e));
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const patchEdit = (patch: Partial<Omit<Edit, "kind" | "name" | "lastSavedMeta">>) => {
    setSelected((cur) => {
      if (!cur || cur.kind !== "edit") return cur;
      const next: Edit = { ...cur, ...patch };
      queueAutosave(next);
      return next;
    });
  };

  const patchDraft = (patch: Partial<Omit<Draft, "kind">>) => {
    setSelected((cur) => {
      if (!cur || cur.kind !== "draft") return cur;
      const next: Draft = { ...cur, ...patch };
      queueAutosave(next);
      return next;
    });
  };

  const discardDraft = () => {
    cancelPendingSave();
    setSelected(null);
    setSaveState("idle");
    setSaveErr("");
  };

  // Flush pending autosave on navigate-away so the user doesn't lose the
  // last few characters they typed. keepalive lets the request outlive
  // the page.
  useEffect(() => {
    const onHide = () => {
      if (saveTimer.current === null) return;
      if (!selected) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const tags = parseTags(selected.tagsText);
      if (selected.kind === "edit") {
        fetch(`/api/resources/markdown/${encodeURIComponent(selected.name)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags, content: selected.content }),
          keepalive: true,
        }).catch(() => {});
      } else if (selected.kind === "draft" && NAME_PATTERN.test(selected.name)) {
        fetch("/api/resources/markdown", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: selected.name, tags, content: selected.content }),
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
    };
  }, [selected]);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Markdown</h1>
        <button onClick={startDraft}>➕ New markdown</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Reusable chunks of prose — coding style, house rules, docs — pushed
        into a session's context dir on demand. Each file caps at
        <code className="mono">{" "}256 KiB</code>; the editor below gives
        you markdown highlighting.
      </div>
      {listErr && <div className="error-banner">{listErr}</div>}

      <div
        style={{
          display: "flex",
          gap: 0,
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--bg-card)",
          minHeight: 520,
        }}
      >
        <MarkdownSidebar
          list={list}
          selected={selected}
          onOpen={openMarkdown}
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {selected ? (
            <EditorPane
              selection={selected}
              saveState={saveState}
              saveErr={saveErr}
              onPatchDraft={patchDraft}
              onPatchEdit={patchEdit}
              onDelete={() =>
                selected.kind === "edit" ? deleteMarkdown(selected.name) : discardDraft()
              }
            />
          ) : (
            <div className="empty" style={{ padding: 60, textAlign: "center" }}>
              Pick a markdown on the left or hit ➕ to create one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkdownSidebar(props: {
  list: MarkdownMeta[];
  selected: Selection;
  onOpen: (name: string) => void;
}) {
  return (
    <div
      className="scroll-panel"
      style={{
        width: 240,
        flex: "0 0 240px",
        borderRight: "1px solid var(--border)",
        background: "var(--bg-elev)",
        padding: 6,
        overflowY: "auto",
      }}
    >
      {props.selected?.kind === "draft" && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 6,
            marginBottom: 4,
            background: "rgba(106,164,255,0.10)",
            border: "1px solid rgba(106,164,255,0.35)",
            fontSize: 12,
          }}
        >
          <span style={{ fontWeight: 600 }}>
            {props.selected.name || <span className="muted">(new draft)</span>}
          </span>
          <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
            not yet saved
          </div>
        </div>
      )}
      {props.list.length === 0 ? (
        <div className="muted" style={{ padding: 8, fontSize: 12 }}>
          No markdowns yet.
        </div>
      ) : (
        props.list.map((m) => {
          const active = props.selected?.kind === "edit" && props.selected.name === m.name;
          return (
            <div
              key={m.name}
              onClick={() => props.onOpen(m.name)}
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                marginBottom: 2,
                cursor: "pointer",
                background: active ? "rgba(106,164,255,0.12)" : "transparent",
                borderLeft: active ? "3px solid var(--accent)" : "3px solid transparent",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: active ? 600 : 500, color: "var(--fg)" }}>
                {m.name}
              </div>
              <div className="mono muted" style={{ fontSize: 10, marginTop: 2 }}>
                {formatBytes(m.bytes)} · {relativeTime(m.updated_at)}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function EditorPane(props: {
  selection: Draft | Edit;
  saveState: "idle" | "dirty" | "saving" | "saved" | "error";
  saveErr: string;
  onPatchDraft: (patch: Partial<Omit<Draft, "kind">>) => void;
  onPatchEdit: (patch: Partial<Omit<Edit, "kind" | "name" | "lastSavedMeta">>) => void;
  onDelete: () => void;
}) {
  const { selection } = props;
  const isDraft = selection.kind === "draft";
  const nameOk = !isDraft || NAME_PATTERN.test(selection.name);
  const bytes = utf8ByteLength(selection.content);
  const overLimit = bytes > MARKDOWN_CONTENT_LIMIT;

  const onPatch = (patch: Partial<Omit<Draft, "kind">>) => {
    if (isDraft) props.onPatchDraft(patch);
    else props.onPatchEdit(patch);
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: 14 }}>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
            Name
          </div>
          {isDraft ? (
            <input
              value={selection.name}
              placeholder="coding-style"
              onChange={(e) => onPatch({ name: e.target.value })}
              autoFocus
            />
          ) : (
            <div
              className="mono"
              style={{
                padding: "6px 10px",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              {selection.name}
            </div>
          )}
          {isDraft && selection.name && !nameOk && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4, color: "var(--warn)" }}>
              letters/digits/<code>._-</code> only, max 64 chars
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
            Tags <span className="muted">(comma-separated)</span>
          </div>
          <input
            value={selection.tagsText}
            placeholder="style, policy"
            onChange={(e) => onPatch({ tagsText: e.target.value })}
          />
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 320,
          border: "1px solid var(--border)",
          borderRadius: 6,
          overflow: "hidden",
          background: "#1e1e1e",
        }}
      >
        <Suspense
          fallback={
            <div className="muted" style={{ padding: 16, fontSize: 12 }}>
              Loading Monaco…
            </div>
          }
        >
          <MarkdownMonacoEditor
            value={selection.content}
            onChange={(v) => onPatch({ content: v })}
          />
        </Suspense>
      </div>

      <div
        className="row"
        style={{ justifyContent: "space-between", marginTop: 10, fontSize: 12, flexWrap: "wrap", gap: 8 }}
      >
        <div className="mono muted" style={{ fontSize: 11 }}>
          {formatBytes(bytes)} / {formatBytes(MARKDOWN_CONTENT_LIMIT)}
          {overLimit && (
            <span style={{ color: "var(--danger)", marginLeft: 8 }}>
              over limit — saves will fail
            </span>
          )}
        </div>
        <SaveIndicator
          isDraft={isDraft}
          nameValid={nameOk && (!isDraft || !!selection.name)}
          saveState={props.saveState}
          saveErr={props.saveErr}
          lastSavedMeta={selection.kind === "edit" ? selection.lastSavedMeta : null}
        />
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        {isDraft ? (
          <>
            <button className="secondary" onClick={props.onDelete}>Discard</button>
            <div className="muted" style={{ fontSize: 11 }}>
              Autosaves once the name is valid.
            </div>
          </>
        ) : (
          <>
            <button className="danger" onClick={props.onDelete}>Delete</button>
            <div className="muted" style={{ fontSize: 11 }}>
              Edits save automatically.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SaveIndicator(props: {
  isDraft: boolean;
  nameValid: boolean;
  saveState: "idle" | "dirty" | "saving" | "saved" | "error";
  saveErr: string;
  lastSavedMeta: MarkdownMeta | null;
}) {
  if (props.isDraft && !props.nameValid) {
    return <span className="muted" style={{ fontSize: 11 }}>Draft — name required</span>;
  }
  if (props.saveState === "error") {
    return (
      <span style={{ fontSize: 11, color: "var(--danger)" }} title={props.saveErr}>
        Save failed — {props.saveErr.slice(0, 60)}
      </span>
    );
  }
  if (props.saveState === "saving") {
    return <span className="muted" style={{ fontSize: 11 }}>Saving…</span>;
  }
  if (props.saveState === "dirty") {
    return <span className="muted" style={{ fontSize: 11 }}>Edited — autosave queued…</span>;
  }
  const when = props.lastSavedMeta?.updated_at;
  if (when) {
    return (
      <span className="muted" style={{ fontSize: 11 }} title={fullTime(when)}>
        Saved {relativeTime(when)}
      </span>
    );
  }
  return null;
}

function parseTags(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
