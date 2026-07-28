# soulseek-claude-skill

A Claude skill that finds the highest-quality copy of a song on Soulseek and downloads it,
via a local [slskd](https://github.com/slskd/slskd) instance and a focused MCP server.

## Requirements

- [bun](https://bun.sh)
- A Soulseek account (username + password)
- Either Docker (Desktop, running) **or** — in Docker-less environments — nothing extra:
  setup falls back to running slskd as a native binary (auto-downloaded).

## Setup

```bash
bun install
SLSK_USERNAME=youruser SLSK_PASSWORD=yourpass bun run setup.ts
```

This bootstraps slskd, writes `~/.config/slskd/slskd.yml`, downloads to
`~/Music/soulseek/`, and registers the `soulseek` MCP server with Claude (user scope).
If you omit the env vars, setup prompts for them.

### Docker vs native

setup auto-detects how to run slskd:

- **Docker present** → runs the official `slskd/slskd` container (the default).
- **No Docker** (e.g. a container/sandbox without Docker-in-Docker) → runs slskd as a
  **native binary** with no Docker required. It uses a `slskd` already on your `PATH`,
  otherwise downloads the pinned release (`SLSKD_VERSION`, default `0.26.0`) for your
  OS/arch into `~/.config/slskd/bin/`.

Force a mode with `bun run setup.ts --native` or `--docker`. The MCP server itself never
needs Docker — it only needs a reachable slskd (`SLSKD_BASE_URL` + `SLSKD_API_KEY`).

> Lost your password? SoulseekQt stores it in **plaintext** in its `soulseek.scd1`
> config (and on Windows, the `login` value under `HKCU\Software\Soulseek2\config`).
> Tools like Soulseek Password Recovery can read it back.
>
> Security: the generated `~/.config/slskd/slskd.yml` stores your password in plaintext.
> Keep it private; don't commit it.

- `bun run setup.ts --status` — check Docker container / native process + health
- `bun run setup.ts --reset` — stop the container or native process (keeps config)

## Usage

Ask Claude things like:
- "grab the FLAC of Radiohead – Weird Fishes via soulseek"
- "download <song>, lossless only"
- "get me the highest quality <track>"

## Development

```bash
bun test          # run all tests
bun run typecheck # tsc --noEmit
```

## Architecture

- `setup.ts` — slskd (Docker or native binary) + MCP bootstrap
- `src/slskd-client.ts` — typed slskd REST client
- `src/pick-best.ts` — pure quality ranking + fake-lossless sanity checks
- `src/mcp-server.ts` — MCP server exposing 5 tools
- `SKILL.md` — the workflow Claude follows
