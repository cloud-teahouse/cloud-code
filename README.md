# Cloud Code CLI

A fork of Kimi Code CLI with some interesting features — multi-provider, GUI-grade TUI, swarm-native.

Cloud Code CLI is a coding agent that lives in your terminal: it reads your codebase, plans and executes multi-step tasks, runs commands, edits files, and coordinates teams of subagents — with a full-screen TUI designed to be driven by keyboard *and* mouse.

> Forked from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (MIT). Much of the code is inherited from upstream; see [NOTICE](NOTICE) for attribution.

## Highlights

- **Multi-provider by design** — Kimi (OAuth or API key), ChatGPT Codex (OAuth with plan usage, rate-limit windows and reset-credit redeeming), plus fully customizable providers and models (CRUD built into `/provider` and `/model`). Subagents can run on a different model than the main agent.
- **A TUI that behaves like a GUI** — mouse click/hover everywhere, floating dialogs, a virtual scrollbar, per-card click-to-expand, searchable pickers, vim mode, and a dual architecture (fullscreen bottom-slot, or a classic inline mode for small terminals).
- **Swarm-native** — in-process teammates with a shared task list, mailbox protocol, and a leader permission bridge; a coordinator mode for orchestrated multi-worker runs.
- **Engineering-depth** — git worktree isolation, prompt prefix-cache discipline, per-step projection caching, durable cron, project/user memory, output styles, plugins (kimi-code and Claude Code formats, custom marketplaces), and a `/status` dashboard with per-account usage and activity stats.

## Install

Prebuilt binaries (linux/macOS/windows, x64 + arm64) are on the [Releases](https://github.com/cloud-teahouse/cloud-code/releases) page.

```sh
# Install script (release channel by default; --channel=beta for the rolling beta)
curl -fsSL https://raw.githubusercontent.com/cloud-teahouse/cloud-code/main/scripts/install.sh | bash

# npm (platform binary fetched on install)
npm install -g @cloud-teahouse/cloudcode-cli
```

Then run `cloudcode`, and `/login` to connect an account.

## Verifying a release

Every release publishes `sha256sums.txt` together with a detached [minisign](https://jedisct1.github.io/minisign/) signature, `sha256sums.txt.minisig`. The signing key is:

```
RWRSCedfeEAUBWZPDn2NRhR1Wgb+c3PvDMQYZOKXwpK37dzjBK+XxeZ+
```

The install script, the npm package's installer, and `/update apply` all check that signature before they believe a single checksum, and refuse to install if it is missing or invalid — a checksum file served from the same page as the artifacts it describes proves the download arrived intact, not that we published it. The key is pinned in this repository ([`release-keys.ts`](apps/cloud-code/src/cli/update/release-keys.ts)), so trusting a release means trusting a commit here, not a Release page.

To check a download by hand:

```sh
minisign -Vm sha256sums.txt -P RWRSCedfeEAUBWZPDn2NRhR1Wgb+c3PvDMQYZOKXwpK37dzjBK+XxeZ+
sha256sum -c --ignore-missing sha256sums.txt
```

## Update

Inside the app: `/update` checks the latest release; `/update apply` downloads, verifies the release signature and the sha256, and swaps the binary with a backup.

## Development

```sh
pnpm install
pnpm build
pnpm test        # full suite
pnpm run typecheck
```

See [AGENTS.md](AGENTS.md) for repository layout and conventions, and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow.

## License

MIT — see [LICENSE](LICENSE). Contains code from MoonshotAI/kimi-code (MIT).
