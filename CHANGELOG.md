# Changelog

Only user-visible changes. Latest first. Before v1.0.0, each minor
version gets one summary entry here; for line-level detail, read the
commit log between the two adjacent tags.

## v0.5.0 — 2026-04-22

- One-click self-upgrade from the topbar — checks GitHub, installs in place, rolls over without dropping your `serve` terminal. Popover shows the real release notes and the `vA → vB` pair.
- Per-session VS Code (coder/code-server), same flow as the file browser — one click to spawn, "Open VS Code ↗" lands in the session's workdir.
- Real BotDock logo in the topbar, browser favicon, and README header; Notes panel gains an `A- / A+` font-size control.
- Keyboard Send no longer auto-presses Enter — Enter is its own quick key, so typing into a Claude prompt doesn't submit by accident.
- Workspace remembers the last-selected session across reloads; transcript view auto-follows the latest page as new turns land.
- Release notes shown in the update popover (and on the GitHub release page) now come from CHANGELOG + full commit messages, not just subjects.
- `botdock serve` restart resets filebrowser + code-server state so stale "Open" links don't point at dead tunnels.
- Fixes: installing one embedded tool no longer wipes another's marker; supervisor port-detection no longer trips when the inner process died inside a live tmux; Events panel stops labeling lifecycle breadcrumbs as `error`.

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
