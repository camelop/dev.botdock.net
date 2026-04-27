# Alternative solutions

## 1. Claude's official remote-control / mobile app

> Important: works well together with BotDock — if all you need is to keep a session going from your phone, the mobile app slots in nicely on top.

**Similarities**

- Manages multiple sessions in one UI.

**Differences**

Pros:

- Works with mobile devices out of the box.
- Prettier UI than the TUI.
- No need for public IPs on the target host (e.g. you can reach a session running inside a Docker container).

Cons:

- Reduced feature set compared with the TUI (e.g. task tracking, agent teams).
- Sessions sometimes get accidentally closed.
- Claude Code only.

## 2. Enhanced tmux (e.g. tmux-in-tmux + Tabby) on a long-running server

**Similarities**

- Stores sessions across disconnects.
- Keeps the original TUI experience.

**Differences**

Pros:

- One less tool to install.
- Also supports rich tagging / session customization.

Cons:

- No agent-awareness (no status tracking, etc.).
- Setup effort, especially if you want tmux-in-tmux to span another server.
- Requires an extra server that's always running.
- Migration burden when you switch machines.

## 3. [agent-deck](https://github.com/asheshgoplani/agent-deck) — an earlier inspiration

**Similarities**

- Manages multiple sessions in one UI.
- Supports multiple agent kinds.

**Differences**

Pros:

- Better forking experience (forking is on the BotDock roadmap for a future release).
- Pretty TUI.

Cons:

- Learning curve, especially for the TUI key shortcuts.
- Local-first design (I personally don't want to run `--dangerously-skip` / auto mode on my own laptop).

---

**Feel free to PR if you know of other alternatives.**
