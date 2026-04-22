/**
 * Lazy-loadable Monaco editor configured for markdown authoring.
 *
 * This file is the only place Monaco is imported, so every import here
 * lands in the `monaco-editor` chunk that Vite splits out when the
 * MarkdownsPage lazy-imports this module. The initial app bundle stays
 * Monaco-free — users who never open the Context → Markdown page pay
 * zero Monaco cost.
 *
 * Worker: Monaco spawns a web worker for tokenisation / background
 * analysis. Vite's `?worker` suffix turns the target file into a worker
 * module bundled separately; `MonacoEnvironment.getWorker` is the
 * hand-off point the `monaco-editor` package checks on startup.
 */

import { useEffect, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Hook our bundled Monaco + worker into the loader once per session.
// Repeated calls are harmless (the library dedupes internally).
let configured = false;
function ensureConfigured() {
  if (configured) return;
  (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
  loader.config({ monaco });
  configured = true;
}

export function MarkdownMonacoEditor(props: {
  value: string;
  onChange: (next: string) => void;
  /** Font size in px. Defaults to 13. */
  fontSize?: number;
  /** CSS height — the Editor needs an explicit height or a flex parent. */
  height?: number | string;
}) {
  ensureConfigured();

  // Keep the callback in a ref so Monaco's onChange closure stays stable;
  // rebinding it on every render is wasteful and races against the
  // library's internal effects.
  const onChangeRef = useRef(props.onChange);
  useEffect(() => { onChangeRef.current = props.onChange; }, [props.onChange]);

  return (
    <Editor
      height={props.height ?? "100%"}
      defaultLanguage="markdown"
      language="markdown"
      value={props.value}
      theme="vs-dark"
      options={{
        fontSize: props.fontSize ?? 13,
        minimap: { enabled: false },
        wordWrap: "on",
        lineNumbers: "on",
        // Markdown is pure prose — keep the gutter minimal but keep
        // line numbers since the user asked for them.
        folding: false,
        glyphMargin: false,
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        // Tab = 2 spaces matches the surrounding styles and most markdown
        // style guides. Users can still indent-with-tab if they prefer;
        // we're only setting the default.
        tabSize: 2,
        insertSpaces: true,
        // Prevent the editor from swallowing Cmd/Ctrl+S in a way that
        // surprises users — we catch saves at the app level via
        // autosave, so the builtin save action is a no-op here.
        automaticLayout: true,
      }}
      onChange={(v) => onChangeRef.current(v ?? "")}
    />
  );
}
