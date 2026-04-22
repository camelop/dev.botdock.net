# Changelog

Only user-visible changes. Latest first. Before v1.0.0, each minor
version gets one summary entry here; for line-level detail, read the
commit log between the two adjacent tags.

## v0.5.0 — 2026-04-22

- Resume an existing Claude Code conversation from the New Session modal.
- Full-screen Workspace (three-column hub) with aliases, accent colors, tags, drag/resize preferences persisted across reloads.
- Per-session file browser and per-session VS Code (coder/code-server) — one-click spawn, opens in the session's workdir, clean Stop.
- Per-session floating notepad — draggable, resizable, auto-saves to `sessions/<id>/notes.md`.
- In-process self-upgrade: topbar click checks GitHub, downloads + SHA256-verifies + `.bak`-swaps the binary, `execv`s the same PID so the user's terminal rolls over cleanly; frontend reloads on instance-id change.
- Server-side paginated transcript with auto-follow of the latest page; "syncing" activity state while the poller drains a backlog.
- Release workflow builds the release body from CHANGELOG + full commit messages; in-app update popover shows real notes and `vA → vB`.
- Keyboard panel: Send delivers text only; Enter is its own quick key (no more accidental submits when typing into a CC prompt).
- Real BotDock logo in topbar, browser favicon, and README header.
- Events panel correctly separates info breadcrumbs from real errors.

## v0.4.0 — 2026-04-21

Collapsed into v0.5.0 above. See `git log v0.3.2..v0.5.0` for the
patch-level history.

## v0.3.0 — 2026-04-20

- Workspace page (three-column hub) with sidebar, aliases, tags, config dialog.
- Session aliases + colors + tags persist in meta.toml and apply globally (Dashboard, Card view, List, modal).
- Per-session filebrowser scaffolding; foundational UI polish across all session views.
- ControlMaster / ENOBUFS fixes that kept long-running sessions stable.

## v0.2.0 — 2026-04-20

- Initial War Room (later renamed Card view) with animated agent-state badges.
- Two-column session detail modal; transcript renders every entry.
- CC session / pending state model (`active`/`pending`), transcript sync from remote jsonl.

## v0.1.0 — 2026-04-19

- First usable milestone: remote session launcher (generic-cmd), web UI, REST + WS, machine + key + secret CRUD.
