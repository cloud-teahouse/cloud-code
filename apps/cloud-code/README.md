# @cloud-teahouse/cloudcode-cli

> The Starting Point for Next-Gen Agents

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## What is Cloud Code CLI

Cloud Code CLI is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

## Install

Cloud Code CLI is not yet published to npm or a binary CDN, so build it from source.
You need Node.js 24.15.0 or later and pnpm:

```sh
git clone https://github.com/yspbwx2010/cloud-code.git
cd cloud-code
pnpm install
pnpm build
```

Then link the CLI onto your PATH:

```sh
cd apps/cloud-code && npm link
cloudcode --version
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Cloud Code CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
cloudcode
```

On first launch, run `/login` inside Cloud Code CLI and choose Kimi Code (OAuth), ChatGPT Codex (OAuth), or a Kimi Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **Single-binary distribution.** Install with one command — no Node.js setup, no PATH gymnastics, no global module conflicts.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Repository & Issues

- Source: https://github.com/yspbwx2010/cloud-code
- Issues: https://github.com/yspbwx2010/cloud-code/issues

## License

MIT
