# Cloud Code CLI

Kimi Code CLI 的 fork，加了一些有趣的功能——多供应商、GUI 级 TUI、原生 swarm 协作。

Cloud Code CLI 是一个住在终端里的编码 agent：读你的代码库、规划并执行多步任务、跑命令、改文件、协调子代理团队——全屏 TUI 同时为键盘和鼠标设计。

> 本项目 fork 自 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)（MIT），大部分代码继承自上游。署名见 [NOTICE](NOTICE)。

## 亮点

- **多供应商设计** — Kimi（OAuth 或 API key）、ChatGPT Codex（OAuth，含套餐用量、限额窗口与重置机会兑换），以及完全自定义的供应商与模型（/provider 与 /model 内置增删改）。子代理可以与主代理使用不同模型。
- **像 GUI 一样的 TUI** — 全鼠标点击/悬停、浮层对话框、虚拟滚动条、卡片点击展开、可搜索选择器、vim 模式、双架构（全屏 bottom-slot，或为小终端准备的经典 inline 模式）。
- **原生 swarm** — 进程内 teammate（共享任务列表、mailbox 协议、leader 权限桥），以及编排多 worker 的 coordinator 模式。
- **工程深度** — git worktree 隔离、前缀缓存纪律、逐步投影缓存、持久化 cron、项目/用户记忆、output styles、插件（kimi-code 与 Claude Code 双格式、自定义 marketplace）、/status 双账号用量与活动统计面板。

## 安装

预编译二进制（linux/macOS/windows，x64 + arm64）见 [Releases](https://github.com/cloud-teahouse/cloud-code/releases) 页面。

```sh
# 安装脚本（默认 release 通道；--channel=beta 装滚动 beta 版）
curl -fsSL https://raw.githubusercontent.com/cloud-teahouse/cloud-code/main/scripts/install.sh | bash

# npm（安装时按平台拉取二进制）
npm install -g @cloud-teahouse/cloudcode-cli
```

运行 `cloudcode`，然后 `/login` 连接账号。

## 更新

应用内：`/update` 检查最新版本；`/update apply` 下载、校验（sha256）并替换二进制（自动备份）。

## 开发

```sh
pnpm install
pnpm build
pnpm test        # 全量测试
pnpm run typecheck
```

仓库结构与约定见 [AGENTS.md](AGENTS.md)，贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT — 见 [LICENSE](LICENSE)。包含 MoonshotAI/kimi-code（MIT）的代码。
