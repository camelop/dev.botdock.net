# BotDock context skill

A [Claude Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
that teaches the target agent how to discover and use resources pushed
into a session's workdir by the [BotDock](https://github.com/camelop/dev.botdock.net)
command center.

The skill lives on this orphan branch (`skill/botdock-context`) so that
BotDock can install it into any session's workdir with a single
`git clone --branch skill/botdock-context`. It has no shared history
with the main BotDock codebase — just the one `SKILL.md`.

## Manual install

```bash
mkdir -p .claude/skills
git clone --depth 1 --branch skill/botdock-context \
    https://github.com/camelop/dev.botdock.net.git \
    .claude/skills/botdock-context
```

Or use the "Install skill" button in BotDock's ＋ Context popover — it
does exactly that over ssh to the session's machine.

## What's inside

- `SKILL.md` — the skill definition (YAML frontmatter + instructions).
  Claude auto-loads this when it runs in a workdir containing
  `.claude/skills/<name>/SKILL.md`.
- `README.md` — this file. Not part of the skill proper; just for humans
  browsing the branch on GitHub.
