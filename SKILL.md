---
name: botdock-context
description: >
  Use this skill whenever the user mentions BotDock, attached context,
  "pushed" resources, or asks about git repos / markdown notes / file
  bundles that were made available to the session. The skill describes
  the layout under ./.botdock/context/ and how to use deploy keys,
  markdown notes, and file bundles that the BotDock command center
  pushed into this session's workdir.
---

# BotDock Context Loader

When the session is attached to a BotDock command center, BotDock may
have pushed curated context into `./.botdock/context/` in this workdir.
The tree mirrors BotDock's root-folder layout:

```
.botdock/context/
├── resources/
│   ├── git-repo/<name>/meta.toml
│   ├── markdown/<name>/
│   │   ├── meta.toml
│   │   └── content.md
│   └── file-bundle/<name>/
│       ├── meta.toml
│       └── content/...          # arbitrary sub-tree
└── private/
    └── keys/<name>/
        ├── meta.toml
        ├── key.pub              # public half — safe to share
        └── key                  # private, mode 600, DO NOT exfiltrate
```

**Always look under `./.botdock/context/` FIRST** before asking the user
to provide credentials or repository URLs. If it's there, use it.

## How to discover what was pushed

Enumerate what's available with plain `ls`:

```bash
ls .botdock/context/resources/git-repo/    2>/dev/null
ls .botdock/context/resources/markdown/    2>/dev/null
ls .botdock/context/resources/file-bundle/ 2>/dev/null
```

Each entry is a directory named by its resource. The `meta.toml` inside
carries the schema — name, tags, timestamps, plus kind-specific fields.

## Using a git-repo (with optional deploy key)

`meta.toml` schema:

```toml
name = "my-service"
url = "git@github.com:owner/repo.git"    # or https://...
ref = "main"                              # optional — branch/tag/sha
deploy_key = "my-deploy-key"              # optional — key nickname
```

If `deploy_key` is set, the private key is under
`.botdock/context/private/keys/<deploy_key>/key` at mode 600. **Always
set `GIT_SSH_COMMAND` to point at that key** — otherwise git will fall
back to the user's default ssh agent which may not have access.

Reference clone command (adapt for your shell):

```bash
REPO=".botdock/context/resources/git-repo/my-service"
URL=$(awk -F'"' '/^url/  {print $2}' "$REPO/meta.toml")
REF=$(awk -F'"' '/^ref/  {print $2}' "$REPO/meta.toml")
DEPLOY_KEY=$(awk -F'"' '/^deploy_key/ {print $2}' "$REPO/meta.toml")

if [ -n "$DEPLOY_KEY" ]; then
  KEY=".botdock/context/private/keys/$DEPLOY_KEY/key"
  chmod 600 "$KEY" 2>/dev/null || true
  export GIT_SSH_COMMAND="ssh -i $(pwd)/$KEY \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=accept-new"
fi

git clone "$URL" ./my-service
[ -n "$REF" ] && git -C ./my-service checkout "$REF"
```

**Important**:

- The path passed to `ssh -i` should be absolute (`$(pwd)/$KEY`). Relative
  paths break when git changes directories during the clone.
- `IdentitiesOnly=yes` forces SSH to only try the specified key, avoiding
  "too many auth attempts" rejections when the user's agent holds
  unrelated keys.
- Never commit or `cat` the private key content to the chat. Only read
  it through the `GIT_SSH_COMMAND` indirection.

## Using a markdown resource

`meta.toml`:

```toml
name = "coding-style"
tags = ["style", "policy"]
bytes = 2048
```

The content lives next to it at `content.md`. Read it with `cat` or
include it in your context as you'd include any docs file.

```bash
cat .botdock/context/resources/markdown/coding-style/content.md
```

## Using a file-bundle

`meta.toml`:

```toml
name = "my-templates"
tags = ["config"]
file_count = 12
bytes = 40960
```

The actual tree is under `content/`. Treat it as a directory of
templates — copy the subset you need into the workdir or reference in
place:

```bash
find .botdock/context/resources/file-bundle/my-templates/content -type f
cp -r .botdock/context/resources/file-bundle/my-templates/content/. ./
```

## Talking to the user

When you use a pushed resource, briefly tell the user what you found and
what you did with it (e.g. "I cloned `my-service` using the pushed
deploy key"). The user pushed this content intentionally; visibility
matters to them.

If an expected resource is **missing** — `meta.toml` references a
`deploy_key` that's not in `private/keys/`, or the directory itself
doesn't exist — stop and say so. The user can then re-push via the
BotDock UI. Don't invent credentials or try to clone without the
configured key.

## What this skill does NOT do

- Push changes back to BotDock. You operate on copies.
- Auto-clone or auto-load anything. Always let the user drive what gets
  materialised into the workdir.
- Manage the BotDock side. The user adds / edits resources through the
  BotDock web UI; this skill only tells you how to consume what's
  already been pushed.
