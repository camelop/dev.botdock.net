# Changelog

Only user-visible changes. Grouped by day; latest first.

## 2026-04-21

- **Incremental transcript loading.** SessionView now caches each session's
  transcript / raw / events bytes per-tab; re-opening the same session
  tells the daemon to stream only what's new instead of re-transferring
  the entire jsonl. Multi-MB resumed conversations used to reparse from
  scratch on every session switch and every page-number click — that
  round-trip is gone.
- **New "syncing" activity state.** While the poller is still draining a
  transcript backlog (remote_transcript_offset < remote_transcript_size)
  the session shows a blue spinner badge and a "syncing" pill instead of
  being misreported as "running". Flips to running/pending the moment
  the local mirror catches up.

- **Session tags for the Workspace sidebar.** Configure any number of
  tags per session (Config dialog → Tags row, Enter to add). The
  sidebar grows one group per distinct tag; a session with multiple
  tags is rendered once per tag so it's visible from any of its
  perspectives. Active sessions without tags stay in the classic
  "Active" group; Needs attention is now an overlay that duplicates
  pending-unacked rows so they always surface at the top of the
  sidebar regardless of tags. Selecting a session highlights every
  appearance of it, across all groups it's in.
- **Stronger selection highlight.** The selected sidebar row now has a
  thicker 4px accent border, a tinted background, and an inset ring —
  much easier to spot when the same session is repeated under multiple
  groups.
- **Double-click config is back.** In addition to the Config button in
  the session header, double-clicking a sidebar row opens the same
  config dialog directly on that session.

- **Aliases + colors apply globally.** Dashboard Recent, Sessions List,
  Card view (both the pending-strip and the grid cards), Workspace
  sidebar, and the session modal title now all render the session name
  through a shared `SessionNameChip` component that honors the alias
  and paints the chip background with the chosen color. The original
  session id + cmd + machine/workdir survive as a multi-line hover
  tooltip wherever the chip is shown.

- **Config dialog replaces double-click rename.** The session detail
  header (modal + workspace) now has a `Config` button next to
  Deactivate. Opens a dialog with an Alias input and a color-swatch
  row. The picked color paints the sidebar row's **name background**
  (not the text); foreground flips to dark-on-warm / light-on-deep
  automatically so it stays readable.
- **Fix: Open-in-workspace no longer lands on the first session.** The
  hub's refresh loop was eagerly selecting `list[0]` on initial load,
  which beat the `hub-preselect` hint to the punch. It now leaves
  selection null when there's no prior choice, and the preselect effect
  picks the intended session on the next render. Hub refresh failures
  also surface as an error banner instead of being silently swallowed.

- **Server-side aliases + colors for sessions.** Double-click a Workspace
  sidebar row to open a small editor: rename the session and pick an
  accent color from a 9-swatch palette. Stored in `meta.toml` (not
  localStorage), so it's the same across browsers and survives reloads.
  Color drives the sidebar row's left border and the name text tint.
- **Workspace sidebar sort** is now purely by newest transcript activity
  (falling back to start/created time) — the old localStorage
  last-access heuristic is gone.
- **Action bar reorganized.** Left side: ＋ Context, ⌨ Keyboard (was
  "Input"). Right side: zoom −/%/+, ⇲ Workspace (modal only), ↗ New
  tab, ⛶ Full screen, ↻ reload.
- **Events panel** keeps its compact height but the rows are two-line
  now (kind pill + time on the top row, payload underneath) at a
  smaller font size.
- **Transcript page counter is click-to-jump.** Tap the `N/total · count`
  label to type a page number; Enter jumps, Esc cancels.

## 2026-04-21 (earlier)

- **Resume an existing Claude Code conversation.** New session modal
  (claude-code only) has a "Resume a previous conversation" picker that lists
  every `~/.claude/projects/*/*.jsonl` on the selected machine — sorted
  newest-first, with workdir, mtime, and a preview of the opening user
  message. Selecting one rewrites the workdir to match and switches the
  launch from `claude "$PROMPT"` to `claude --resume <uuid>` inside a fresh
  BotDock tmux (so transcript-sync, ttyd, and activity detection all still
  work). Sessions whose workdir still has a live `claude` process on the
  remote get a "⚠ already opened" badge — you can still pick them, but
  submitting pops a confirm because resuming a held jsonl forks a new
  branch instead of continuing cleanly.
- **Session tables now show the original prompt for resumed sessions.**
  Dashboard Recent and Sessions → List pull the first user message from
  the resumed transcript at pick time, so the mono "cmd" column no longer
  shows an empty cell or "(resume abcd1234)".
- **Pagination for the transcript view** (20 turns/page, newest-first),
  plus a "jump to latest" button. Long resumed conversations no longer
  render hundreds of turns in one shot.
- **Events panel is shorter by default** (220 → 140 px) so the transcript
  above it stays visible without scrolling.
- **Activity detection understands newer CC entry types.** A turn that
  ended with `last-prompt` or `permission-mode` (both written while CC is
  idle) no longer keeps the session flagged as "running".
- **Session modal → Workspace jump button.** The terminal toolbar in the
  detail modal has a new "⇲ Workspace" button that closes the modal and
  opens the session in the full-screen Workspace view.
- **Sessions nav reorganized.** Dropdown order is now Workspace → Card
  view → List view; "War Room" has been renamed to "Card view".
- **Hard reload when the daemon restarts.** `/api/status` returns a
  per-process `instance_id`; if it changes between polls the UI does
  `window.location.reload()` instead of clinging to dead websockets.
  Two failed polls in a row raise a blocking "Server unreachable"
  overlay with a reload button.
- **Transcript sync handles multi-MB backlogs.** The poller chunks each
  stream at 256 KiB per tick so `spawnSync`'s 1 MiB stdout buffer doesn't
  ENOBUFS on a resumed conversation with a large pre-existing jsonl.
  Offsets advance by bytes received rather than jumping to the remote
  file size, so the backlog drains cleanly over several polls.
- **cc-sessions endpoint preview extraction** now walks up to 200 lines
  (the first few are permission-mode / file-history-snapshot scaffolding
  on newer CC versions) and matches `message.role == "user"`, skipping
  tool-result wrappers.
