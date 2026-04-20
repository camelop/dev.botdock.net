# BotDock 设计概览（v0.3）

> 本文档记录当前已对齐的设计。v0.3 已收敛，进入 M0 实现前无更多挂起问题。

## 1. 产品定位

BotDock 是**本地的单用户 agent 司令塔**。一台"基地机"上运行 BotDock 服务，用它来：

1. **管理资源**：SSH key、远程机器（含跳板）、以及可复用的上下文资源（git repo / markdown / 文件包 / secret 等）。
2. **调度并操控 agent session**：在登记过的机器上拉起 agent（首版聚焦 Claude Code），向其**推送上下文资源**、**手动下发任务**，并持续 **monitor 执行进展**。
3. **归档历史**：session 的规范化 transcript、事件流、资源推送/请求记录全部留档。

---

## 2. 技术栈与运行形态

- **后端**：TypeScript + Bun。单进程守护，HTTP + WebSocket。
- **前端**：React SPA，打包后由 Bun 服务直接托管。
- **存储**：纯文件系统。**不用 SQLite**。
- **Serve**：用户在数据目录下执行启动命令（类似 `bun botdock serve`）起服务，默认监听 `127.0.0.1`。

---

## 3. 目录布局

"数据目录 = 工作目录"。格式约定：**所有存储元数据用 TOML，流式日志用 NDJSON，API 用 JSON**。

```
<botdock-home>/
├── config.toml                    # 全局配置（端口、认证等）
│
├── private/                       # 敏感物。v1 不加密，靠 FS 权限
│   ├── keys/
│   │   └── <nickname>/            # 整个文件夹以 nickname 命名，便于整体拷贝
│   │       ├── key                # 私钥，0600
│   │       ├── key.pub
│   │       └── meta.toml
│   └── secrets/
│       └── <name>/
│           ├── value              # 原始值（也可以是文件）
│           └── meta.toml
│
├── machines/
│   └── <name>.toml                # host/port/user/key/jump 链
│
├── resources/                     # 第一层 = 类别，第二层 = 资源名
│   ├── git-repo/
│   │   └── <name>/
│   │       └── meta.toml          # url、deploy_key（指向 private/keys/<nick>）等
│   ├── markdown/
│   │   └── <name>/
│   │       ├── meta.toml
│   │       └── content.md
│   └── file-bundle/
│       └── <name>/
│           ├── meta.toml
│           └── content/           # rsync 过去的内容
│
└── sessions/
    └── <session-id>/
        ├── meta.toml              # machine / workdir / agent_kind / 状态
        ├── transcript.ndjson      # 规范化 agent transcript（见 §5.3）
        ├── events.ndjson          # lifecycle + 状态变化（running/waiting/…）
        ├── pushes.ndjson          # 推送 / 请求历史（哪个 resource 何时推过去）
        └── raw/                   # 原始 stdout/stderr
```

---

## 4. SSH Key 与 Machine

### 4.1 Key
- UI 可"生成 ed25519 + 命名"或导入已有。
- 一个 key = `private/keys/<nickname>/` 一整个文件夹，整体可拷贝。

### 4.2 Machine（必须支持跳板）
```toml
# machines/prod-gpu-1.toml
name = "prod-gpu-1"
host = "10.0.0.7"
port = 22
user  = "ubuntu"
key   = "prod"                 # private/keys/prod
tags  = ["gpu", "prod"]

# 跳板链，按顺序执行 ProxyJump
[[jump]]
host = "bastion.example.com"
port = 22
user = "jump"
key  = "bastion"
# 需要多跳时追加更多 [[jump]]
```
- "测试连接"按钮：走完整跳板链跑 `echo ok`。

---

## 5. Agent Session

### 5.1 Session 身份

一个 session = **四元组**：
- `machine`：哪台机器
- `workdir`：机器上的工作目录（创建 session 时指定；BotDock 会在其下维护 `.botdock/`）
- `agent_kind`：目前 `claude-code`（一等公民）+ `generic-cmd`（保留通用入口）
- `context_set`：**不是一次性绑定**，而是一条**推送/请求历史**（`pushes.ndjson`），未来支持 agent 主动请求

### 5.2 生命周期 & 状态

```
create → provisioning → running ⇄ waiting → exited (ok|err)
                         │
                         └→ failed_to_start
```

**Claude Code 专属**：需要区分 `running`（正在执行/调用工具）与 `waiting`（等待用户输入）。v1 通过解析 CC 自身的 transcript / 输出模式识别，写入 `events.ndjson`。

### 5.3 规范化 transcript

`transcript.ndjson` 每行一条事件，字段初拟：

```json
{"ts": "...", "role": "user|assistant|tool", "kind": "message|tool_use|tool_result|state", "content": {...}, "source": "cc|botdock"}
```

Claude Code 的原生 transcript（JSONL）会被映射到这个统一格式；未来加其它 agent kind 时各写一个映射器。

### 5.4 启动流程（v1）

1. BotDock 通过 SSH 在 `workdir/.botdock/` 下铺设目录骨架（结构见 §6）。
2. 把用户本轮选择推送的 resources 同步进 `.botdock/`（**不做类别特化处理**，原样镜像）。
3. 远端 `tmux new-session -d -s botdock-<id> '<agent launcher>'` 启动 agent。
4. 一个轻量 **remote shim**（**纯 shell，零 runtime 依赖**）包裹 agent：
   - 用 `tmux pipe-pane` 把 pane 输出直通到 `workdir/.botdock/session/raw.log`。
   - 一个后台 shell 循环定时 `echo` heartbeat 并监听 agent 状态变化，追加到 `events.ndjson`。
   - 借用 tmux 的 `send-keys` / `pipe-pane` 能力，避免自己实现 pty / 后台进程管理。

### 5.5 状态同步（v1 = A）

- BotDock daemon 对每个 running session 维护一条 SSH 长连接，`tail -F` 远端事件/日志，断线重连并按 offset 续读。
- **不假设反向可达**。反向推送留给未来的"端口转发模块" + Claude Code 自装 hook/skill 主动回推（见 `future-forwarding.md`）。

### 5.6 任务下发 & 监控

UI 支持向 running session 手动下发新任务（不只是初始 prompt）。采用 **A + B 双通道**：

- **A. 文件落盘**：写入 `workdir/.botdock/tasks/<n>.md`。由 CC skill 教 agent 何时 / 如何读取。**长任务、结构化内容、需要留档**的都走这条。
- **B. tmux send-keys**：直接把文本注入 CC stdin。**交互式追加 / 短指令**走这条。

两种通道每次下发都同步写入 `events.ndjson`（便于时间线展示）。

---

## 6. Context 推送（统一协议）

**原则**：不做类别特化投递，**把司令塔本机的 resources 结构原样镜像到远端 `workdir/.botdock/`**。agent 怎么用，由一个单独的 **Claude Code skill** 教它。

远端 session 工作目录形态：

```
<workdir>/
└── .botdock/
    ├── resources/
    │   ├── markdown/<name>/{meta.toml, content.md}
    │   ├── git-repo/<name>/meta.toml            # 含 url + 本地 deploy key 路径
    │   └── file-bundle/<name>/{meta.toml, content/}
    ├── secrets/
    │   └── <name>/{value, meta.toml}
    ├── tasks/                                    # §5.6 方案 A 的任务落盘
    ├── session/                                  # shim 写入的日志/心跳
    └── README.md                                 # 告诉 agent：存在一个 skill 会教你用这里
```

推送历史统一记录到 BotDock 本机的 `sessions/<id>/pushes.ndjson`。

> 好处：新增一类 resource 时，**不需要改 session 端代码**；只需（可选地）更新 skill 让 agent 知道怎么消费它。

---

## 7. Web UI

- **框架**：React SPA，单页应用，路由前端自管。
- **主要视图**：
  1. **Dashboard** — session 列表（状态徽章：running / waiting / exited）、机器列表
  2. **Resources** — keys / machines / secrets / 各类 resource 的 CRUD
  3. **New Session** — 选机器 + workdir + agent_kind + 初始 prompt。**不选 resources**（资源推送是 session 建立后独立动作）
  4. **Session 详情** — 元信息、实时 transcript、事件时间线、**"推送 resources" 动作（多选，每次可挑任意子集）**、**"下发任务" 输入框（A/B 通道可选）**、stop
  5. **Secrets / Keys** — 敏感内容的查看需二次确认（即便单用户也防误操作）

---

## 8. 安全 / 认证

- 默认 `127.0.0.1`；远程访问强制走 SSH 端口转发（v1 不引入自建 TLS）。
- v1 可选 bearer token（配置在 `config.toml`）。
- **单用户模型**，无需 RBAC。

---

## 9. 里程碑 & 当前状态（v0.1.0）

### 已完成

- **M0 · Storage + CLI** ✅
  - Data dir layout (config.toml, private/{keys,secrets}, machines/, resources/, sessions/, forwards/, private/credit_accounts/)
  - TOML/JSON/NDJSON 读写，path-escape 防护，atomic writes
  - CLI: `botdock init / key / machine / secret / serve`
- **M1 · Web UI + API** ✅
  - Bun.serve + React SPA (embed in compiled binary)
  - REST + WebSocket, bearer auth hook
  - 全 CRUD 页面 + Dashboard
- **M2 · Generic-cmd sessions** ✅
  - SSH + pure-shell shim, tmux 管理，stdout → raw.log 自动重定向
  - Poller 同步事件到本地 events.ndjson，状态机 running/exited/failed_to_start
- **M3 · Claude-code sessions（部分完成）**
  - ✅ `claude-code` agent kind + 初始 prompt
  - ✅ 任务下发：A=文件落盘 `.botdock/tasks/` 骨架 + B=tmux send-keys + 快捷键（Enter / Esc / 方向键 / Ctrl-C ...）
  - ✅ CC session jsonl 路径捕获（`cc_session_file` / `cc_session_uuid`）
  - ✅ ttyd 嵌入：per-session 动态 spawn ttyd + local forward + `/api/sessions/:id/terminal/*` 反代 + iframe
  - ⏳ transcript 规范化（把 CC 的 jsonl 同步回本地 `transcript.ndjson` 并映射成统一 schema）
  - ⏳ running/waiting 状态识别（现在统一 running，不区分"agent 正在思考"vs"等用户"）

### 同期完成的（不在原 M 里程碑）

- **Port-forward 模块（原 Phase 3B 设想）** ✅
  - Local / Remote / Dynamic(SOCKS) 三向
  - 系统托管 vs 用户创建分离
  - 用户 local forward 可一键走 `/api/forwards/:name/proxy/*` 开新 tab / 嵌 iframe
- **Per-machine terminal** ✅
  - 自动检测 + apt-install tmux（Linux） / 下载 ttyd binary（Linux x64/arm64/arm）
  - `~/.botdock/installed.toml` marker 避免重复装
  - 每机器一条管理态 forward + ttyd 反代到 `/api/machines/:name/terminal/*`
  - Terminals 独立页（Machines ▾），懒连接（默认灰暗 + Connect 按钮）+ Full-screen
- **Budgets tab（credit tracker）** ✅
  - `private/credit_accounts/<nick>/{value, meta.toml}` 本地存凭据
  - Anthropic API（admin key）→ `GET /v1/organizations/cost_report` 自动刷余额 30d
  - Card 式 dashboard + 手动 refresh；Claude Pro/Max 订阅无公开 API，只能占位
- **打包 / 分发** ✅
  - Bun --compile 单二进制（Linux + macOS，x64 + arm64）
  - 前端 base64 embed 进二进制
  - install.sh（API 解析 latest tag，防 redirect 缓存）+ GH Actions 发布
- **导航** ✅
  - Logo + 分组下拉（Private / Machines）

### 未做 / 延后

- **M3 收尾**
  - `transcript.ndjson` 规范化：通过 scp 把远端 `~/.claude/projects/<hash>/<uuid>.jsonl` 同步回本地，解析成统一 transcript 格式（user/assistant message、tool_use、tool_result）
  - running / waiting 状态识别：可能通过解析 CC 输出、或 CC 未来 hook 上报
- **M4 · Resource 推送到 `.botdock/`**
  - git-repo / secret / markdown / file-bundle 四类镜像到远端 session workdir 的 `.botdock/resources/`
  - 配套 CC skill 教 agent 怎么用
- **M5 · git-repo 深度集成 + jump host 打磨**
  - deploy key 注入 git clone
  - 多跳更顺手

（舍弃 / 延后：session 复现、日志轮转、多用户、加密）


---

## 10. 已对齐的关键决策（速查）

| 议题 | 决策 |
|------|------|
| 技术栈 | TS + Bun（后端）/ React SPA（前端） |
| 持久化 | 纯文件系统，无 SQLite |
| 存储格式 | 元数据统一 TOML（含 private/keys、private/secrets），流日志 NDJSON，API JSON |
| 敏感物存放 | `private/{keys,secrets}/<name>/`，v1 不加密 |
| Machine | 必须支持 jump host 链（`[[jump]]`） |
| Session 身份 | 四元组：machine + workdir + agent_kind + context 推送历史 |
| Agent kind | v1：`claude-code`（一等）+ `generic-cmd`（保留） |
| CC 状态识别 | 区分 running / waiting |
| Resource 推送协议 | 原样镜像到远端 `workdir/.botdock/`，不做类别特化；由 CC skill 教 agent 使用 |
| Resource 推送触发 | **纯手动**，UI 多选要推的资源 |
| 任务下发通道 | A（文件落盘 `.botdock/tasks/`）+ B（tmux send-keys）双通道 |
| Remote shim | 纯 shell，充分利用 tmux `pipe-pane` / `send-keys` |
| 状态同步 | v1 = 方案 A（BotDock 主动 SSH tail），反向通道见 `future-forwarding.md` |
| 用户模型 | 单用户 |
| 暂不做 | 加密、日志轮转、session 复现、多用户、RBAC |
