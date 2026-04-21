# Changelog

Only user-visible changes. Latest first.

## v0.4.0 — 2026-04-21

- Resume an existing Claude Code conversation from the New Session modal.
- New full-screen Workspace (three-column hub) with aliases, accent colors, tags, and drag-to-persist preferences.
- Per-session file browser — one-click spawn of filebrowser.org scoped to the workdir, reverse-proxied at `/api/sessions/:id/files/`.
- Per-session floating notepad: draggable, resizable, auto-saves to `sessions/<id>/notes.md`.
- Transcript is now server-paginated — long sessions open instantly; other pages load on click.
- New "syncing" activity state while the poller drains a backlog; hard reload when the daemon restarts.
- Action bar reshuffled: zoom −/%/+, Keyboard, FileBrowser group, Notes, and Open-in-Workspace jumps.
- Advanced New Session options: custom launch command and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` opt-in.
- Dashboard gets a "⇲ Workspace" button; Needs-attention group tints amber when non-empty.
- Fixes: ControlMaster bottleneck that stalled concurrent sessions, ENOBUFS on multi-MB transcripts, misreported "running" after CC idle-state writes.
