# Changelog

Only user-visible changes. Grouped by day; latest first.

## 2026-04-21

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
