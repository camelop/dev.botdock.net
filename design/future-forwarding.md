# 端口 / 目录 / 服务 转发模块（未来版本占位）

> 状态：**未启动**。本文档仅为占位，记录范围与触发场景。
> 触发此模块设计的时机：当 v1 的"BotDock 主动 SSH tail"方案无法满足实时性/交互性时。

## 定位

BotDock 后续需要一套**统一的转发层**，把远端机器上的资源（端口、文件目录、网页服务等）安全地暴露到 BotDock 基地机（以及基地机的浏览器 UI）。

## 覆盖的形态（预期）

- **端口转发**：远端 TCP 端口 ↔ 基地机本地端口
  - 用途：让远端 agent 的反向回调（例如 CC 的 hook/skill 主动 POST 事件）能打到基地机。
  - 用途：让本地浏览器访问远端的调试面板 / 服务。
- **目录转发 / 挂载**：远端某个目录映射到基地机本地（基于 sshfs 或增量同步）
  - 用途：查看远端 session `workdir/` 内容，或把本地编辑实时反映过去。
- **HTTP 反向代理**：远端 HTTP 服务通过 BotDock 暴露给本机浏览器，支持鉴权 + 路径前缀重写。

## 与 agent session 的关系

- 一旦有了"端口转发"，**§5.5 的状态同步可切到方案 B**：remote shim / Claude Code hook / skill 主动 POST 事件到基地机（经 SSH 反向隧道），延迟更低、开销更小。
- "目录转发"让 UI 可以直接在基地机这边浏览 `workdir/.botdock/` 的内容，而不需要每次走一次 SSH fetch。

## 尚未决定

- 走 OpenSSH 原生 `-R / -L` + 进程托管，还是自己基于 ssh2 库实现？
- 与 machine / session 的数据模型如何绑定（一条 forward 是挂在 machine 上还是 session 上）？
- UI 表达（一个 "Forwards" tab vs. 挂在 machine 详情页下）。

> 等到 v1 跑起来、具体需求更明确时再展开。
